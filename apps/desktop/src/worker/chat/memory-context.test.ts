import { expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createMemoryContextTransform } from './memory-context.js';
import { request } from '../agent/pi-chat-agent-test-helpers.js';

it('keeps valid memory discoverable after a durable receipt loses its body, while a fresh read remains usable', async () => {
  const input = request();
  const entry = { id: 'preference', revision: 1, summary: 'Language preference', content: 'Use Chinese for replies.', applicability: 'Replies', scope: '用户通用', origin: 'explicit' };
  input.context.memory = { state: 'ready', entries: [entry] };
  const refs = [{ id: entry.id, revision: entry.revision }];
  const transform = createMemoryContextTransform(input, { request: async () => ({ result: { status: 'ok', useEnabled: true, validRefs: refs } }) });
  const receipt = (payload: unknown): AgentMessage => ({ role: 'toolResult', toolCallId: 'read', toolName: 'memory_read', isError: false, timestamp: 1, content: [{ type: 'text', text: JSON.stringify(payload) }] });
  const restored = await transform(Array.from({ length: 30 }, () => receipt({ status: 'historical_reference', memoryRefs: refs, message: 'Body hidden' })));
  expect(JSON.stringify(restored[0])).toContain(entry.content);
  const fresh = await transform([receipt({ status: 'ok', memoryRefs: refs, entries: [entry] })]);
  expect(JSON.stringify(fresh)).toContain(entry.content);
  expect(JSON.stringify(fresh).match(/Use Chinese for replies/g)).toHaveLength(1);
});

it('keeps a fresh validated read recognizable, while durable and invalidated reads hide their arguments and body', async () => {
  const { projectMemoryHistory, memoryReferenceKey } = await import('@deepfield/contracts');
  const ref = { id: 'test-memory', revision: 1 };
  const messages = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'call-read', name: 'memory_read', arguments: { id: ref.id } }] },
    { role: 'toolResult', toolCallId: 'call-read', toolName: 'memory_read', content: [{ type: 'text', text: JSON.stringify({ status: 'ok', memoryRefs: [ref], entries: [{ ...ref, content: 'Current evidence' }] }) }] },
  ];
  const live = projectMemoryHistory(messages, new Set([memoryReferenceKey(ref)]));
  expect(live[0]).toEqual(messages[0]);
  const valid = new Set([memoryReferenceKey(ref)]);
  // A receipt for another call or tool cannot authorize exposed arguments.
  for (const change of [{ toolCallId: 'other' }, { toolName: 'memory_search' }]) {
    expect(JSON.stringify(projectMemoryHistory([messages[0]!, { ...messages[1]!, ...change }], valid)[0])).toContain('memoryHistory');
  }
  const writes = messages.map(message => message.role === 'assistant'
    ? { ...message, content: [{ type: 'toolCall', id: 'call-read', name: 'memory_remember', arguments: { content: 'Private write' } }] }
    : { ...message, toolName: 'memory_remember' });
  expect(JSON.stringify(projectMemoryHistory(writes, valid)[0])).not.toContain('Private write');
  const alreadyHidden = projectMemoryHistory(messages);
  expect(JSON.stringify(projectMemoryHistory(alreadyHidden, valid)[0])).toContain('memoryHistory');
  expect(JSON.stringify(live[1])).toContain('Current evidence');
  for (const hidden of [projectMemoryHistory(messages), projectMemoryHistory(messages, new Set())]) {
    expect(JSON.stringify(hidden[0])).toContain('memoryHistory');
    expect(JSON.stringify(hidden)).not.toContain('Current evidence');
  }
});

it('keeps the query of a live empty search so its negative result can be interpreted, without reviving durable queries', async () => {
  const { projectMemoryHistory } = await import('@deepfield/contracts');
  const messages = [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'search-empty', name: 'memory_search', arguments: { query: 'absent topic' } }] },
    { role: 'toolResult', toolCallId: 'search-empty', toolName: 'memory_search', content: [{ type: 'text', text: JSON.stringify({ status: 'miss', memoryRefs: [], entries: [] }) }] },
  ];
  expect(projectMemoryHistory(messages, new Set())[0]).toEqual(messages[0]);
  expect(JSON.stringify(projectMemoryHistory(messages)[0])).not.toContain('absent topic');
});


it('gives a child readonly memory guidance without assigning main-agent responsibilities', async () => {
  const input = request(); input.context.memory = { state: 'empty', entries: [] };
  const transform = createMemoryContextTransform(input, { request: async () => ({ result: { status: 'ok', useEnabled: true, validRefs: [] } }) }, 'child_agent');
  const messages = JSON.stringify(await transform([]));
  expect(messages).toContain('只读子Agent');
  expect(messages).not.toContain('唯一负责');
  expect(messages).not.toContain('memory_remember');
});
