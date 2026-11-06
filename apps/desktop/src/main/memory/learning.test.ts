import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase, type DatabaseOwner } from '@deepfield/base/database/runtime';
import { createSqliteMemory, estimatedTokens } from '@deepfield/base/memory/sqlite';
import { createRepositories, migrate, type Repositories } from '@deepfield/persistence';
import type { AgentWorkerRequest, ConversationId, LlmRuntimeSnapshot, MemorySettings } from '@deepfield/contracts';
import type { ConfigHandle } from '@deepfield/base/config';
import type { ModelGateway } from '../../shared/model-gateway.js';
import { ChatMemoryHost } from './host.js';
import { createMemoryLearning } from './learning.js';
import type { MemoryModelRequest } from '@deepfield/base/memory/runtime';
const owners: DatabaseOwner[] = [];
const hosts: ChatMemoryHost[] = [];
const llm: LlmRuntimeSnapshot = {
  id: 'test-profile',
  name: 'Fixture',
  provider: 'deepseek',
  protocol: 'openai_compatible',
  baseUrl: 'https://invalid.example',
  modelId: 'test-model',
  contextWindow: 128000,
  apiKey: 'not-used'
};
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  hosts.splice(0).forEach(h => h.dispose());
  await Promise.resolve();
  await Promise.resolve();
  owners.splice(0).forEach(o => o.close());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function config(): ConfigHandle<MemorySettings> {
  let values: MemorySettings = {
    useEnabled: true,
    autoLearnEnabled: true,
    noticeSeen: true
  };
  return {
    getView: async () => ({
      values: {
        ...values
      },
      secretStatus: {}
    }),
    save: async draft => {
      values = {
        ...draft.values
      };
      return {
        values: {
          ...values
        },
        secretStatus: {}
      };
    },
    resolveSnapshot: async () => {
      throw new Error('unused');
    },
    resolveDraft: async () => {
      throw new Error('unused');
    }
  };
}
function gateway(completeText: ModelGateway['completeText']): ModelGateway {
  return {
    completeText,
    createModel() {
      throw new Error('unused');
    },
    async getApiKey() {
      throw new Error('unused');
    }
  };
}
async function fixture(completeText: ModelGateway['completeText'] = async () => JSON.stringify({
  changes: []
}), fake = false) {
  const owner = openDatabase(':memory:');
  owners.push(owner);
  owner.legacy(db => migrate(db));
  let host!: ChatMemoryHost;
  const repos = createRepositories(owner.database, {
    beforeConversationDeleteInTransaction: id => host.invalidateConversationInTransaction(id)
  });
  const settings = config();
  const model = gateway(completeText);
  async function assemble() {
    host = new ChatMemoryHost(createSqliteMemory({
      database: owner.scope('base:memory').database
    }), owner.scope('base:chat-memory').database, repos, settings);
    hosts.push(host);
    await host.initialize();
    host.learning = createMemoryLearning({
      host,
      resolveLlm: async () => llm,
      model,
      fake
    });
    return host;
  }
  await assemble();
  return {
    owner,
    repos,
    model,
    get host() {
      return host;
    },
    assemble
  };
}
let requestIndex = 0;
function start(host: ChatMemoryHost, repos: Repositories, conversation: ConversationId, text = '以后回答先给结论，再给依据。') {
  const requestId = `request-${++requestIndex}`;
  const message = repos.messages.append(conversation, 'user', text, requestId);
  const request: AgentWorkerRequest = {
    requestId,
    kind: 'chat.prompt',
    prompt: text,
    context: {
      conversationId: conversation,
      systemPrompt: '',
      messages: []
    },
    options: {
      webSearch: false
    },
    llm,
    toolAccess: {
      network: 'disabled',
      maxAgentTurns: 6,
      maxSearchCalls: 0,
      maxFetchCalls: 0
    }
  };
  host.userActivity();
  host.prepare(request);
  return {
    requestId,
    message
  };
}
function complete(host: ChatMemoryHost, repos: Repositories, conversation: ConversationId, text?: string) {
  const result = start(host, repos, conversation, text);
  repos.messages.append(conversation, 'assistant', '好的。', result.requestId);
  host.completed(result.requestId);
  host.finished(result.requestId);
  return result;
}
function four(host: ChatMemoryHost, repos: Repositories, conversation: ConversationId) {
  return Array.from({
    length: 4
  }, () => complete(host, repos, conversation));
}
function response(prompt: string) {
  const request = JSON.parse(prompt) as MemoryModelRequest;
  return JSON.stringify({
    changes: [{
      operation: 'remember',
      input: {
        kind: 'preference',
        summary: '先给结论',
        content: '回答先给结论，再给依据。',
        applicability: '一般回答'
      },
      sources: [{
        id: request.sources[0]!.source.id,
        version: request.sources[0]!.source.version
      }]
    }]
  });
}
it('waits for four successful unhandled messages and 60 idle seconds, makes one bounded request, and persists recall', async () => {
  const model = vi.fn<ModelGateway['completeText']>(async (_llm, _system, prompt) => response(prompt));
  const f = await fixture(model);
  const conversation = f.repos.conversations.create().id;
  for (let i = 0; i < 3; i++) complete(f.host, f.repos, conversation);
  await vi.advanceTimersByTimeAsync(60000);
  expect(model).not.toHaveBeenCalled();
  complete(f.host, f.repos, conversation);
  await vi.advanceTimersByTimeAsync(59999);
  expect(model).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(model).toHaveBeenCalledTimes(1);
  const sent = JSON.parse(model.mock.calls[0]![2]) as MemoryModelRequest;
  expect(sent.sources).toHaveLength(4);
  expect(estimatedTokens(sent) + sent.maxOutputTokens).toBeLessThanOrEqual(6000);
  expect(model.mock.calls[0]![1]).toBe('');
  expect(model.mock.calls[0]![4]).toEqual({
    maxTokens: 1200
  });
  expect(f.host.store.reader([f.host.userScope]).search('回答结论')[0]?.content).toBe('回答先给结论，再给依据。');
  expect(f.host.learningStatus()[0]?.status).toBe('saved');
  await vi.advanceTimersByTimeAsync(120000);
  expect(model).toHaveBeenCalledTimes(1);
});
it('does not count failed/explicitly handled messages and pauses new dispatch while the user is active', async () => {
  const model = vi.fn<ModelGateway['completeText']>(async () => JSON.stringify({
    changes: []
  }));
  const f = await fixture(model);
  const c = f.repos.conversations.create().id;
  const failed = start(f.host, f.repos, c);
  f.host.finished(failed.requestId);
  for (let i = 0; i < 3; i++) complete(f.host, f.repos, c);
  await vi.advanceTimersByTimeAsync(60000);
  expect(model).not.toHaveBeenCalled();
  const handled = complete(f.host, f.repos, c);
  f.host.db.run('UPDATE chat_memory_sources SET handled=1 WHERE id=?', handled.message.id);
  await vi.advanceTimersByTimeAsync(60000);
  expect(model).not.toHaveBeenCalled();
  complete(f.host, f.repos, c);
  const active = start(f.host, f.repos, c);
  await vi.advanceTimersByTimeAsync(120000);
  expect(model).not.toHaveBeenCalled();
  f.host.finished(active.requestId);
  await vi.advanceTimersByTimeAsync(59999);
  expect(model).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(model).toHaveBeenCalledTimes(1);
});
it('disable/re-enable skips closed-period and old pending messages and processes only new interactions', async () => {
  const model = vi.fn<ModelGateway['completeText']>(async () => JSON.stringify({
    changes: []
  }));
  const f = await fixture(model);
  const c = f.repos.conversations.create().id;
  const old = four(f.host, f.repos, c);
  await f.host.configure({
    autoLearnEnabled: false
  });
  const closed = four(f.host, f.repos, c);
  await vi.advanceTimersByTimeAsync(60000);
  expect(model).not.toHaveBeenCalled();
  await f.host.configure({
    autoLearnEnabled: true
  });
  await vi.advanceTimersByTimeAsync(60000);
  expect(model).not.toHaveBeenCalled();
  const fresh = four(f.host, f.repos, c);
  await vi.advanceTimersByTimeAsync(60000);
  expect(model).toHaveBeenCalledTimes(1);
  const ids = (JSON.parse(model.mock.calls[0]![2]) as MemoryModelRequest).sources.map(s => s.source.id);
  expect(ids).toEqual(fresh.map(s => s.message.id));
  expect(ids.some(id => [...old, ...closed].some(s => s.message.id === id))).toBe(false);
});
it('conversation deletion during a provider request prevents late storage and removes job/source metadata', async () => {
  let release!: (value: string) => void;
  let prompt = '';
  const model = vi.fn<ModelGateway['completeText']>(async (_llm, _system, text) => {
    prompt = text;
    return new Promise(r => {
      release = r;
    });
  });
  const f = await fixture(model);
  const c = f.repos.conversations.create().id;
  four(f.host, f.repos, c);
  await vi.advanceTimersByTimeAsync(60000);
  expect(model).toHaveBeenCalledTimes(1);
  f.repos.conversations.delete(c);
  release(response(prompt));
  await vi.advanceTimersByTimeAsync(1);
  expect(f.host.store.listRecords([f.host.userScope], {
    includeInactive: true
  })).toEqual([]);
  expect(f.host.db.all('SELECT * FROM chat_memory_jobs')).toEqual([]);
  expect(f.host.db.all('SELECT * FROM chat_memory_sources')).toEqual([]);
});
it('marks interrupted work durable, avoids restart replay, and permits only explicit retry of valid sources', async () => {
  let release!: (value: string) => void;
  const model = vi.fn<ModelGateway['completeText']>().mockImplementationOnce(async () => new Promise(r => {
    release = r;
  })).mockResolvedValue(JSON.stringify({
    changes: []
  }));
  const f = await fixture(model);
  const c = f.repos.conversations.create().id;
  four(f.host, f.repos, c);
  await vi.advanceTimersByTimeAsync(60000);
  expect(model).toHaveBeenCalledTimes(1);
  f.host.dispose();
  release(JSON.stringify({
    changes: []
  }));
  await vi.advanceTimersByTimeAsync(1);
  const next = await f.assemble();
  next.learning?.wake();
  await vi.advanceTimersByTimeAsync(120000);
  expect(model).toHaveBeenCalledTimes(1);
  expect(next.learningStatus()[0]?.status).toBe('interrupted');
  await next.retry();
  expect(model).toHaveBeenCalledTimes(2);
  expect(next.learningStatus().some(s => s.status === 'empty')).toBe(true);
});
it('skips whole oversized sources, remains under budget, and fake mode never resolves or calls a provider', async () => {
  const model = vi.fn<ModelGateway['completeText']>(async () => {
    throw new Error('must not call');
  });
  const f = await fixture(model, true);
  const c = f.repos.conversations.create().id;
  const long = complete(f.host, f.repos, c, '超长'.repeat(10000));
  for (let i = 0; i < 3; i++) complete(f.host, f.repos, c);
  await vi.advanceTimersByTimeAsync(60000);
  expect(model).not.toHaveBeenCalled();
  expect(f.host.store.reader([f.host.userScope]).search('结论')).toHaveLength(1);
  expect(f.host.learningStatus().some(s => s.status === 'skipped')).toBe(true);
  expect(f.host.db.get('SELECT handled FROM chat_memory_sources WHERE id=?', long.message.id)?.handled).toBe(1);
});
it('records model failures without auto-retry, and rejects old explicit retries after a learning epoch change', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const model = vi.fn<ModelGateway['completeText']>(async () => {
    throw new Error('provider failed secret');
  });
  const f = await fixture(model);
  const c = f.repos.conversations.create().id;
  four(f.host, f.repos, c);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.host.learningStatus()[0]?.status).toBe('failed');
  expect(f.host.get().error).toBeTruthy();
  await vi.advanceTimersByTimeAsync(120000);
  expect(model).toHaveBeenCalledTimes(1);
  await f.host.configure({
    autoLearnEnabled: false
  });
  await f.host.configure({
    autoLearnEnabled: true
  });
  await f.host.retry();
  expect(model).toHaveBeenCalledTimes(1);
  expect(f.host.learningStatus()[0]?.status).toBe('skipped');
});

it('reports truncated model output without saving partial memory or automatically paying for another attempt', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = await fixture();
  const completeResult = vi.fn<NonNullable<ModelGateway['completeTextResult']>>(async () => ({ text: '', stopReason: 'length' }));
  f.model.completeTextResult = completeResult;
  four(f.host, f.repos, f.repos.conversations.create().id);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.host.get().records).toHaveLength(0);
  expect(f.host.get().error).toContain('输出被长度上限截断');
  expect(f.host.learningStatus()[0]?.reason).toContain('输出被长度上限截断');
  await vi.advanceTimersByTimeAsync(120000);
  expect(completeResult).toHaveBeenCalledTimes(1);
});
