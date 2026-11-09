import { expect, it } from 'vitest';
import { createAgentCoordinator } from '@deepfield/base/agent/collaboration/runtime';
import type { ChatCollaborationState } from '@deepfield/contracts';
import type { TraceEvent } from '@deepfield/base/trace';
import { AgentWorkerClient } from './agent-worker-client.js';
import { FakeEndpoint, request } from './agent-worker-client-test-helpers.js';

it('accepts persisted child task/model/tool/usage chains while rejecting unregistered runs and foreign roots', async () => {
  const endpoint = new FakeEndpoint(); const events: TraceEvent[] = [];
  const client = new AgentWorkerClient(endpoint, { trace: event => events.push(event) });
  const coordinator = createAgentCoordinator({ scopeId: 'scope', owner: { kind: 'chat', id: 'c1' }, limits: { deadline: Date.now() + 60_000 }, checkpoint: async () => {},
    execute: async (_request, controls) => new Promise((_resolve, reject) => controls.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  try {
    client.send({ ...request('parent'), trace: { rootTraceId: 'root', spanId: 'host' } });
    const receipt = await coordinator.spawn({ title: 'Write', text: 'Write the draft', configurationId: 'parent' }, 'spawn');
    const state = { snapshot: JSON.stringify(coordinator.snapshot()) } as ChatCollaborationState;
    const base = { version: 1, eventId: 'event', rootTraceId: 'root', spanId: 'child-task', parentSpanId: 'host', requestId: receipt.runId,
      processSessionId: 'worker-session', sequence: 1, time: new Date().toISOString() };
    const task = { ...base, type: 'span.start', kind: 'task', taskId: receipt.taskId, runId: receipt.runId };
    endpoint.emit({ kind: 'trace.event', event: task });
    expect(events).toHaveLength(0);
    client.registerCollaborationTrace('parent', state);
    endpoint.emit({ kind: 'trace.event', event: { ...task, rootTraceId: 'foreign' } });
    endpoint.emit({ kind: 'trace.event', event: { ...task, requestId: 'forged-run' } });
    endpoint.emit({ kind: 'trace.event', event: { ...task, taskId: 'forged-task' } });
    expect(events).toHaveLength(0);
    endpoint.emit({ kind: 'trace.event', event: task });
    endpoint.emit({ kind: 'trace.event', event: { ...base, type: 'span.start', kind: 'model', spanId: 'model', parentSpanId: 'child-task' } });
    endpoint.emit({ kind: 'trace.event', event: { ...base, type: 'usage.link', spanId: 'model', usageAttemptId: 'attempt', serviceKind: 'llm' } });
    endpoint.emit({ kind: 'trace.event', event: { ...base, type: 'span.start', kind: 'tool', spanId: 'read', parentSpanId: 'child-task', toolName: 'memory_read', toolCallId: 'read-call' } });
    expect(events).toHaveLength(4);
    const scope = { rootTraceId: 'root', spanId: 'read', requestId: receipt.runId };
    expect(client.traceForMemory('parent', `${receipt.runId}:read-call`, scope)).toEqual(scope);
    expect(client.traceForMemory('other', `${receipt.runId}:read-call`, scope)).toBeUndefined();
    expect(client.traceForMemory('parent', 'read-call', scope)).toBeUndefined();
    expect(client.traceForMemory('parent', `${receipt.runId}:read-call`, { ...scope, rootTraceId: 'foreign' })).toBeUndefined();
    expect(client.traceForMemory('parent', 'forged:read-call', { ...scope, requestId: 'forged' })).toBeUndefined();
    client.send({ ...request('other'), trace: { rootTraceId: 'other-root', spanId: 'other-host' } });
    client.registerCollaborationTrace('other', state);
    endpoint.emit({ kind: 'trace.event', event: { ...task, rootTraceId: 'other-root' } });
    expect(events).toHaveLength(4);
  } finally { await coordinator.close(); client.dispose(); }
});
