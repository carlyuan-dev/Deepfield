import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { openDatabase, type DatabaseOwner } from '../database/runtime.js';
import { createSqliteMemory, estimatedTokens } from './sqlite.js';
import { createMemoryProcessor, type MemoryModelPort } from './runtime.js';
import type { MemoryInput, MemoryScope, MemorySource } from './index.js';
const owners: DatabaseOwner[] = [];
const dirs: string[] = [];
afterEach(() => {
  owners.splice(0).forEach(o => o.close());
  dirs.splice(0).forEach(d => rmSync(d, {
    recursive: true,
    force: true
  }));
});
const scope: MemoryScope = {
  ownerId: 'local-a',
  namespace: 'chat',
  scopeKey: 'user'
};
const input: MemoryInput = {
  kind: 'preference',
  summary: '报告偏好',
  content: '报告先给结论，再列出依据。',
  applicability: '撰写报告时'
};
function fixture(path = ':memory:') {
  const owner = openDatabase(path);
  owners.push(owner);
  const store = createSqliteMemory({
    database: owner.scope('base:memory').database
  });
  return {
    owner,
    store
  };
}
function source(id = 'msg-1', sequence = 1, kind: MemorySource['kind'] = 'user'): MemorySource {
  return {
    id,
    version: '1',
    sequence,
    kind,
    eligible: true
  };
}
function writer(store: ReturnType<typeof createSqliteMemory>, s = source(), bound = scope) {
  store.registerSources(bound.ownerId, [s]);
  return store.writer(bound, {
    origin: 'user_explicit',
    sources: [s]
  });
}
function processor(store: ReturnType<typeof createSqliteMemory>, model: MemoryModelPort = async () => ({
  changes: [{
    operation: 'remember',
    input,
    sources: [source()]
  }]
})) {
  return createMemoryProcessor({
    store,
    model
  });
}
function proposalArgs() {
  return {
    scope,
    sources: [{
      source: {
        id: 'msg-1',
        version: '1'
      },
      text: '以后写报告先给结论，再列依据。'
    }],
    operationKey: 'extract-1'
  };
}
function change() {
  return {
    operation: 'remember',
    input,
    sources: [{
      id: 'msg-1',
      version: '1'
    }]
  };
}
it('keeps memory contracts browser safe', async () => {
  const r = await build({
    entryPoints: [new URL('./index.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'browser',
    write: false,
    metafile: true
  });
  expect(Object.keys(r.metafile!.inputs).some(p => /sqlite|runtime/.test(p))).toBe(false);
});
it('persists across reopening, recalls Chinese terms and English terms, and returns zero for unrelated questions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const a = fixture(path);
  const r = writer(a.store).remember(input, {
    operationKey: 'save'
  }).record;
  writer(a.store, source('english', 2)).remember({
    kind: 'preference',
    summary: 'Report format',
    content: 'Use concise conclusions and cite evidence in reports.',
    applicability: 'Writing reports'
  }, {
    operationKey: 'english'
  });
  a.owner.close();
  owners.splice(owners.indexOf(a.owner), 1);
  const b = fixture(path);
  const reader = b.store.reader([scope]);
  expect(reader.get(r.id)?.content).toBe(input.content);
  expect(reader.search('报告要怎么写')[0]?.id).toBe(r.id);
  expect(reader.search('reports evidence').some(r => r.summary === 'Report format')).toBe(true);
  expect(reader.search('2 + 2')).toEqual([]);
});
it('binds owner and scope on all IDs; read-only capabilities expose no writer and revoked handles fail', () => {
  const {
    store
  } = fixture();
  const a = writer(store);
  const r = a.remember(input, {
    operationKey: 'a'
  }).record;
  const capability = {
    ...scope,
    namespace: 'capability',
    scopeKey: 'a'
  };
  const other = writer(store, source('cap-b', 2), {
    ...capability,
    scopeKey: 'b'
  });
  expect(other.get(r.id)).toBeUndefined();
  expect(other.history(r.id)).toEqual([]);
  expect(() => other.revise(r.id, 1, input, {
    operationKey: 'bad'
  })).toThrow('inaccessible');
  expect(() => other.forget(r.id, 1)).toThrow('inaccessible');
  expect(store.reader([{
    ...scope,
    ownerId: 'other'
  }]).search('报告')).toEqual([]);
  const readonly = store.reader([scope]);
  expect(readonly).not.toHaveProperty('remember');
  readonly.revoke();
  expect(() => readonly.get(r.id)).toThrow('unavailable');
  a.revoke();
  expect(() => a.remember(input, {
    operationKey: 'revoked'
  })).toThrow('unavailable');
});
it('revisions preserve only five previous versions, detect concurrent edits, and detach manual edits from deleted sources', () => {
  const {
    owner,
    store
  } = fixture();
  let r = writer(store).remember(input, {
    operationKey: 'save'
  }).record;
  for (let n = 2; n <= 8; n++) r = writer(store, source(`edit-${n}`, n)).revise(r.id, r.revision, {
    ...input,
    content: `报告版本 ${n}`
  }, {
    operationKey: `edit-${n}`
  }).record;
  const reader = store.reader([scope]);
  expect(reader.history(r.id).map(h => h.revision)).toEqual([7, 6, 5, 4, 3]);
  expect(() => writer(store, source('stale', 9)).revise(r.id, 1, input, {
    operationKey: 'stale'
  })).toThrow('conflict');
  owner.database.transaction(() => store.invalidateSourcesInTransaction(scope.ownerId, ['msg-1', 'edit-3']));
  expect(reader.get(r.id)?.content).toBe('报告版本 8');
  expect(reader.history(r.id).some(r => r.sources.some(s => s.id === 'edit-3'))).toBe(false);
});
it('forgets body, histories and index, suppresses historical sources, rejects replay and permits a new explicit source', () => {
  const {
    owner,
    store
  } = fixture();
  const a = writer(store);
  const r = a.remember(input, {
    operationKey: 'save'
  }).record;
  const edited = writer(store, source('edit', 2)).revise(r.id, r.revision, {
    ...input,
    content: '报告只给摘要'
  }, {
    operationKey: 'edit'
  }).record;
  writer(store, source('delete', 3)).forget(r.id, edited.revision);
  expect(store.reader([scope]).get(r.id)).toBeUndefined();
  expect(store.reader([scope]).search('报告')).toEqual([]);
  expect(owner.database.all('SELECT * FROM memory_history')).toEqual([]);
  expect(() => a.remember(input, {
    operationKey: 'save'
  })).toThrow('invalidated');
  expect(() => writer(store)).toThrow('invalidated');
  expect(writer(store, source('new-request', 4)).remember(input, {
    operationKey: 'new'
  }).status).toBe('saved');
});
it('learning epochs invalidate pending proposals across disable/re-enable without blocking explicit writes', async () => {
  const {
    store
  } = fixture();
  store.registerSources(scope.ownerId, [source()]);
  store.setLearning(scope.ownerId, true, 0);
  const p = processor(store, async () => ({
    changes: [change()]
  }));
  const proposal = await p.propose(proposalArgs());
  store.setLearning(scope.ownerId, false, 1);
  const manual = writer(store, source('manual', 2)).remember(input, {
    operationKey: 'manual'
  });
  expect(manual.status).toBe('saved');
  store.setLearning(scope.ownerId, true, 3);
  expect(() => p.commit(proposal)).toThrow('invalidated');
  await expect(p.propose({
    ...proposalArgs(),
    operationKey: 'old-source'
  })).rejects.toThrow('invalidated');
  expect(store.reader([scope]).get(manual.record.id)).toBeDefined();
});
it('clear invalidates late commits and all old sources but allows newly registered source sequences', async () => {
  const {
    store
  } = fixture();
  store.registerSources(scope.ownerId, [source()]);
  store.setLearning(scope.ownerId, true, 0);
  const p = processor(store, async () => ({
    changes: [change()]
  }));
  const proposal = await p.propose(proposalArgs());
  writer(store).remember(input, {
    operationKey: 'manual'
  });
  store.clearOwner(scope.ownerId, 1);
  expect(() => p.commit(proposal)).toThrow('invalidated');
  expect(() => writer(store)).toThrow('invalidated');
  expect(writer(store, source('new', 2)).remember(input, {
    operationKey: 'new'
  }).status).toBe('saved');
});
it('source deletion joins a caller transaction, rolls back with it, and invalidates late proposals and merged support', async () => {
  const {
    owner,
    store
  } = fixture();
  store.registerSources(scope.ownerId, [source(), source('second', 2)]);
  store.setLearning(scope.ownerId, true, 0);
  const p = processor(store, async () => ({
    changes: [change()]
  }));
  const proposal = await p.propose(proposalArgs());
  const r = store.writer(scope, {
    origin: 'consumer_confirmed',
    sources: [source(), source('second', 2)]
  }).remember(input, {
    operationKey: 'merged'
  }).record;
  expect(() => owner.database.transaction(() => {
    store.invalidateSourcesInTransaction(scope.ownerId, ['msg-1']);
    throw new Error('rollback');
  })).toThrow('rollback');
  expect(store.reader([scope]).search('报告')).toHaveLength(1);
  owner.database.transaction(() => store.invalidateSourcesInTransaction(scope.ownerId, ['msg-1']));
  expect(store.reader([scope]).search('报告')).toEqual([]);
  expect(store.reader([scope]).get(r.id)?.status).toBe('expired');
  expect(() => p.commit(proposal)).toThrow('invalidated');
  expect(() => store.registerSources(scope.ownerId, [{
    ...source(),
    version: '2'
  }])).toThrow('invalidated');
});
it('requires exact allowed sources and full record revisions and never auto-overwrites manual authority', async () => {
  const {
    store
  } = fixture();
  const r = writer(store).remember(input, {
    operationKey: 'explicit'
  }).record;
  store.setLearning(scope.ownerId, true, 0);
  for (const response of [{
    changes: [{
      ...change(),
      sources: [{
        id: 'invented',
        version: '1'
      }]
    }]
  }, {
    changes: [{
      ...change(),
      scope: {
        ownerId: 'other'
      }
    }]
  }, {
    changes: [{
      ...change(),
      operation: 'revise',
      id: r.id,
      expectedRevision: 1
    }]
  }]) {
    const p = processor(store, async () => response);
    await expect(p.propose({
      ...proposalArgs(),
      existingIds: [r.id]
    })).rejects.toThrow();
  }
  expect(store.reader([scope]).get(r.id)?.content).toBe(input.content);
});
it('auto proposals are idempotent while live, and a concurrent manual edit rejects stale automatic revision', async () => {
  const {
    store
  } = fixture();
  store.registerSources(scope.ownerId, [source()]);
  store.setLearning(scope.ownerId, true, 0);
  const p = processor(store, async () => ({
    changes: [change()]
  }));
  const proposal = await p.propose(proposalArgs());
  const r = p.commit(proposal)[0]!.record;
  expect(p.commit(proposal)[0]?.status).toBe('unchanged');
  store.registerSources(scope.ownerId, [source('correction', 2)]);
  const update = processor(store, async () => ({
    changes: [{
      operation: 'revise',
      id: r.id,
      expectedRevision: r.revision,
      input: {
        ...input,
        content: '先列依据'
      },
      sources: [{
        id: 'msg-1',
        version: '1'
      }, {
        id: 'correction',
        version: '1'
      }]
    }]
  }));
  const next = await update.propose({
    scope,
    existingIds: [r.id],
    sources: [{
      source: source('correction', 2),
      text: '以后先列依据'
    }],
    operationKey: 'revise'
  });
  writer(store, source('manual-edit', 3)).revise(r.id, r.revision, {
    ...input,
    content: '只给结论'
  }, {
    operationKey: 'edit'
  });
  expect(() => update.commit(next)).toThrow('invalidated');
  expect(() => p.commit(proposal)).toThrow('invalidated');
  expect(store.reader([scope]).get(r.id)?.content).toBe('只给结论');
});
it('isolates conflicting automatic rules from recall and preserves explicit rules', async () => {
  const {
    store
  } = fixture();
  store.registerSources(scope.ownerId, [source()]);
  store.setLearning(scope.ownerId, true, 0);
  const p = processor(store, async () => ({
    changes: [change()]
  }));
  const a = p.commit(await p.propose(proposalArgs()))[0]!.record;
  const explicit = writer(store, source('explicit', 2)).remember({
    ...input,
    content: '手动偏好'
  }, {
    operationKey: 'explicit'
  }).record;
  const conflicts = processor(store, async () => ({
    changes: [{
      ...change(),
      input: {
        ...input,
        content: '先列证据'
      },
      conflictsWith: [{
        id: a.id,
        revision: a.revision
      }, {
        id: explicit.id,
        revision: explicit.revision
      }]
    }]
  }));
  conflicts.commit(await conflicts.propose({
    ...proposalArgs(),
    existingIds: [a.id, explicit.id],
    operationKey: 'conflicts'
  }));
  expect(store.reader([scope]).search('报告').map(r => r.id)).toEqual([explicit.id]);
  expect(store.listRecords([scope], {
    includeInactive: true
  }).filter(r => r.status === 'conflicted')).toHaveLength(2);
});
it('enforces complete-item budgets, caps, expiry and rejects oversized extraction before invoking model', async () => {
  const {
    store
  } = fixture();
  const w = writer(store);
  for (let i = 0; i < 15; i++) w.remember({
    ...input,
    summary: `报告 ${i}`,
    content: `报告格式 ${i}`
  }, {
    operationKey: `save-${i}`
  });
  expect(w.search('报告', {
    limit: 100
  })).toHaveLength(8);
  const firstPage = w.listIndex({ limit: 100 });
  expect(firstPage.length).toBeGreaterThan(0);
  expect(firstPage.length).toBeLessThanOrEqual(100);
  expect(firstPage.reduce((sum, row) => sum + Math.ceil(JSON.stringify(row).length / 2), 0)).toBeLessThanOrEqual(2000);
  const remaining = w.listIndex({ offset: firstPage.length, limit: 100 });
  expect(new Set([...firstPage, ...remaining].map(row => row.id)).size).toBe(15);
  expect(w.search('报告', {
    tokenBudget: 1
  })).toEqual([]);
  expect(() => w.search('报告', {
    tokenBudget: NaN
  })).toThrow('invalid_input');
  expect(() => w.remember({
    ...input,
    content: 'a'.repeat(2001)
  }, {
    operationKey: 'long'
  })).toThrow('invalid_input');
  w.remember({
    ...input,
    content: 'expired',
    expiresAt: 1
  }, {
    operationKey: 'expired'
  });
  expect(w.search('expired')).toEqual([]);
  expect(w.search('expired', {
    includeInactive: true
  })).toHaveLength(1);
  store.setLearning(scope.ownerId, true, 0);
  let calls = 0;
  const p = processor(store, async () => {
    calls++;
    return {
      changes: []
    };
  });
  await expect(p.propose({
    ...proposalArgs(),
    sources: [{
      source: source(),
      text: 'x'.repeat(13000)
    }]
  })).rejects.toThrow('budget');
  expect(calls).toBe(0);
  expect(estimatedTokens(w.search('报告'))).toBeLessThanOrEqual(2000);
});
it('keeps scope, source and proposal snapshots isolated from caller/model mutation', async () => {
  const {
    store
  } = fixture();
  const mutable = {
    ...scope
  };
  const s = source();
  const w = writer(store, s, mutable);
  mutable.scopeKey = 'other';
  s.id = 'other';
  const r = w.remember(input, {
    operationKey: 'save'
  }).record;
  expect(r.scope).toEqual(scope);
  r.content = 'tampered';
  expect(w.get(r.id)?.content).toBe(input.content);
  store.setLearning(scope.ownerId, true, 0);
  const response = {
    changes: [change()]
  };
  const p = processor(store, async () => response);
  const proposal = await p.propose(proposalArgs());
  response.changes[0]!.input = {
    ...input,
    content: 'tampered'
  };
  expect(p.commit(proposal)[0]?.record.content).toBe(input.content);
  expect(() => p.commit({
    ...proposal
  })).toThrow('invalid_proposal');
});
it('owner capacity includes inactive records, permits updates/deletions at cap, and retains suppression beyond five revisions', () => {
  const {
    store
  } = fixture();
  const w = writer(store);
  let first = w.remember(input, {
    operationKey: 'first'
  }).record;
  for (let i = 2; i <= 8; i++) first = writer(store, source(`edit-cap-${i}`, i)).revise(first.id, first.revision, {
    ...input,
    content: `报告修订 ${i}`
  }, {
    operationKey: `edit-${i}`
  }).record;
  expect(w.history(first.id)).toHaveLength(5);
  for (let i = 1; i < 2000; i++) w.remember({
    ...input,
    content: `容量条目 ${i}`,
    expiresAt: 1
  }, {
    operationKey: `cap-${i}`
  });
  expect(() => w.remember({
    ...input,
    content: 'overflow'
  }, {
    operationKey: 'overflow'
  })).toThrow('capacity');
  const edit = writer(store, source('latest', 9));
  const updated = edit.revise(first.id, first.revision, {
    ...input,
    content: 'still editable'
  }, {
    operationKey: 'at-cap'
  }).record;
  expect(updated.content).toBe('still editable');
  edit.forget(updated.id, updated.revision);
  expect(() => writer(store)).toThrow('invalidated'); // Source from revision 1 was trimmed from history but stays suppressed.
  expect(writer(store, source('fresh', 10)).remember({
    ...input,
    content: 'new after delete'
  }, {
    operationKey: 'fresh'
  }).status).toBe('saved');
});
it('revalidates source versions and rolls back an entire proposal when any change fails', async () => {
  const {
    store
  } = fixture();
  store.registerSources(scope.ownerId, [source()]);
  store.setLearning(scope.ownerId, true, 0);
  const p = processor(store, async () => ({
    changes: [change(), {
      ...change(),
      input: {
        kind: 'experience',
        summary: '未经验证',
        content: 'This method works.',
        applicability: 'when applicable'
      }
    }]
  }));
  const proposal = await p.propose(proposalArgs());
  expect(() => p.commit(proposal)).toThrow('invalid_sources');
  expect(store.listRecords([scope], {
    includeInactive: true
  })).toEqual([]);
  const p2 = processor(store, async () => ({
    changes: [change()]
  }));
  const stale = await p2.propose(proposalArgs());
  store.registerSources(scope.ownerId, [{
    ...source(),
    version: '2'
  }]);
  expect(() => p2.commit(stale)).toThrow('invalidated');
});
it('bounds one pending model call and propagates cancellation without releasing a still-running request', async () => {
  const {
    store
  } = fixture();
  store.registerSources(scope.ownerId, [source()]);
  store.setLearning(scope.ownerId, true, 0);
  let resolve!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  const p = processor(store, (_request, options) => {
    signal = options.signal;
    return new Promise(r => {
      resolve = r;
    });
  });
  const controller = new AbortController();
  const running = p.propose({
    ...proposalArgs(),
    signal: controller.signal
  });
  await Promise.resolve();
  await expect(p.propose(proposalArgs())).rejects.toThrow('busy');
  controller.abort();
  await expect(running).rejects.toThrow('cancelled');
  expect(signal?.aborted).toBe(true);
  await expect(p.propose(proposalArgs())).rejects.toThrow('busy');
  resolve({
    changes: []
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(store.listRecords([scope])).toEqual([]);
});
it('rejects credential-shaped memory content on the direct path without a model', () => {
  const {
    store
  } = fixture();
  const w = writer(store);
  for (const content of ['密码：my-secret', 'API key: sk-1234567890abcdef12345678', '-----BEGIN PRIVATE KEY-----\nsecret']) expect(() => w.remember({
    ...input,
    content
  }, {
    operationKey: content
  })).toThrow('sensitive_content');
  expect(w.search('secret')).toEqual([]);
});
it('invalidates a pending automatic candidate when a new explicit rule appears after its read snapshot', async () => {
  const {
    store
  } = fixture();
  store.registerSources(scope.ownerId, [source()]);
  store.setLearning(scope.ownerId, true, 0);
  const p = processor(store, async () => ({
    changes: [change()]
  }));
  const proposal = await p.propose(proposalArgs());
  writer(store, source('new-rule', 2)).remember({
    ...input,
    content: '报告只给摘要，不展开依据。'
  }, {
    operationKey: 'explicit-new'
  });
  expect(() => p.commit(proposal)).toThrow('invalidated');
  expect(store.listRecords([scope])).toHaveLength(1);
});
