import { describe, expect, it, vi } from 'vitest';
import { AgentCollaborationError, createAgentCoordinator, type AgentCoordinatorOptions, type AgentExecutionControls, type AgentExecutionRequest } from './runtime.js';
import { parseAgentCoordinatorSnapshot } from './index.js';
const spec = { title: 'Independent task', configurationId: 'admitted-config', text: 'Produce the requested result' };
const result = (text: string) => ({ result: { summary: text, text }, transcript: [{ role: 'assistant', text }] });
function fixture(extra: Partial<AgentCoordinatorOptions> = {}) {
  const started: AgentExecutionRequest[] = [];
  const pending = new Map<string, { controls: AgentExecutionControls; resolve(value: ReturnType<typeof result>): void }>();
  const coordinator = createAgentCoordinator({ scopeId: 'scope', owner: { kind: 'chat', id: 'conversation' },
    limits: { deadline: Date.now() + 60_000, cancellationGraceMs: 5 },
    execute: (request, controls) => { started.push(request); return new Promise(resolve => { pending.set(request.runId, { controls, resolve }); }); },
    ...extra,
  });
  return { coordinator, started, pending };
}
async function running(f: ReturnType<typeof fixture>, count: number) { await vi.waitFor(() => expect(f.started).toHaveLength(count)); }
async function terminal(f: ReturnType<typeof fixture>, taskId: string, status: string) { await vi.waitFor(() => expect(f.coordinator.get(taskId).runs.at(-1)?.status).toBe(status)); }

describe('owner-bound collaboration execution', () => {
  it('retains a classified executor limit without exposing arbitrary exception text', async () => {
    for (const error of [new AgentCollaborationError('model_budget_exceeded'), new Error('private details')]) {
      const f = fixture({ execute: async () => { throw error; } });
      const task = await f.coordinator.spawn(spec, 'limited');
      await terminal(f, task.taskId, 'failed');
      expect(f.coordinator.get(task.taskId).runs[0]!.errorCode).toBe(error instanceof AgentCollaborationError ? 'model_budget_exceeded' : 'execution_failed');
      await f.coordinator.close();
    }
  });

  it('enforces concurrency and cancels queued work without executing it', async () => {
    const f = fixture({ limits: { deadline: Date.now() + 60_000, concurrency: 2, cancellationGraceMs: 5 } });
    const [a,b,c] = await Promise.all(['a','b','c'].map(command => f.coordinator.spawn(spec, command)));
    await running(f, 2); await f.coordinator.cancel(c!.taskId);
    f.pending.get(a!.runId)!.resolve(result('A')); f.pending.get(b!.runId)!.resolve(result('B'));
    await terminal(f, a!.taskId, 'completed'); expect(f.started).toHaveLength(2);
    expect(f.coordinator.get(c!.taskId).runs[0]!.status).toBe('cancelled'); await f.coordinator.close();
  });

  it('retains old results and safe transcript across follow-up, with cumulative limits', async () => {
    const f = fixture({ limits: { deadline: Date.now() + 60_000, maxRuns: 2, cancellationGraceMs: 5 } });
    const a = await f.coordinator.spawn(spec, 'a'); await running(f, 1);
    f.pending.get(a.runId)!.resolve(result('original')); await terminal(f, a.taskId, 'completed');
    const b = await f.coordinator.followUp(a.taskId, { text: 'Revise original' }, 'b'); await running(f, 2);
    expect(f.started[1]!.previousTranscript).toEqual(result('original').transcript);
    f.pending.get(b.runId)!.resolve(result('revised')); await terminal(f, a.taskId, 'completed');
    expect(f.coordinator.readResult({ scopeId: 'scope', taskId: a.taskId, runId: a.runId }).text).toBe('original');
    await expect(f.coordinator.followUp(a.taskId, { text: 'again' }, 'c')).rejects.toMatchObject({ code: 'run_limit' }); await f.coordinator.close();
  });

  it('shares idempotent command receipts and rejects conflicting payloads', async () => {
    const f = fixture(); const [a,b] = await Promise.all([f.coordinator.spawn(spec,'a'), f.coordinator.spawn({ ...spec },'a')]);
    expect(a).toEqual(b); await running(f, 1);
    await expect(f.coordinator.spawn({ ...spec, text: 'different' }, 'a')).rejects.toMatchObject({ code: 'command_conflict' });
    const m = await f.coordinator.send(a.taskId, 'new instruction', 'm');
    expect(m.status).toBe('queued'); expect(f.coordinator.get(a.taskId).runs[0]!.messages[0]!.status).toBe('queued');
    f.pending.get(a.runId)!.controls.onMessage(() => true);
    await vi.waitFor(() => expect(f.coordinator.get(a.taskId).runs[0]!.messages[0]!.status).toBe('delivered'));
    expect(await f.coordinator.send(a.taskId, 'new instruction', 'm')).toEqual(m);
    f.pending.get(a.runId)!.resolve(result('accepted')); await terminal(f, a.taskId, 'completed'); await f.coordinator.close();
  });

  it('cancels from the owning signal and rejects late completion, releasing uncooperative execution', async () => {
    const signal = new AbortController(); const f = fixture({ signal: signal.signal });
    const a = await f.coordinator.spawn(spec, 'a'); await running(f, 1); signal.abort();
    await terminal(f, a.taskId, 'cancelled'); expect(f.pending.get(a.runId)!.controls.signal.aborted).toBe(true);
    f.pending.get(a.runId)!.resolve(result('too late')); await f.coordinator.close();
    expect(f.coordinator.get(a.taskId).runs[0]!.result).toBeUndefined();
    await expect(f.coordinator.spawn(spec, 'b')).rejects.toMatchObject({ code: 'scope_closed' });
  });

  it('does not execute or publish completion before the corresponding durable checkpoint succeeds', async () => {
    let rejectStart = true; let rejectResult = false;
    const f = fixture({ checkpoint: async snapshot => { if (rejectStart || (rejectResult && snapshot.tasks.some(task => task.runs.some(run => run.status === 'completed')))) throw new Error('private filesystem details'); } });
    await expect(f.coordinator.spawn(spec,'a')).rejects.toMatchObject({ code: 'checkpoint_failed' }); expect(f.started).toHaveLength(0); await f.coordinator.close();
    rejectStart = false;
    const g = fixture({ checkpoint: async snapshot => { if (rejectResult && snapshot.tasks.some(task => task.runs.some(run => run.status === 'completed'))) throw new Error('private details'); } });
    const events: string[] = []; g.coordinator.subscribe(event => { if (event.status) events.push(event.status); });
    const a = await g.coordinator.spawn(spec,'a'); await running(g, 1); rejectResult = true;
    g.pending.get(a.runId)!.resolve(result('must remain unpublished')); await terminal(g, a.taskId, 'failed');
    expect(events).not.toContain('completed'); expect(g.coordinator.get(a.taskId).runs[0]!.result).toBeUndefined(); await g.coordinator.close();
  });

  it('restores completed results, interrupts unfinished work and validates owner and event cursor', async () => {
    const f = fixture(); const completed = await f.coordinator.spawn(spec, 'completed'); await running(f, 1);
    f.pending.get(completed.runId)!.resolve(result('persisted result')); await terminal(f, completed.taskId, 'completed');
    const a = await f.coordinator.spawn(spec, 'a'); await running(f, 2);
    const snapshot = parseAgentCoordinatorSnapshot(f.coordinator.snapshot());
    const restored = fixture({ snapshot });
    expect(restored.coordinator.readResult({ scopeId: 'scope', taskId: completed.taskId, runId: completed.runId }).text).toBe('persisted result');
    expect(restored.coordinator.get(a.taskId).runs[0]!.status).toBe('interrupted'); expect(restored.started).toHaveLength(0);
    expect(() => fixture({ snapshot, owner: { kind: 'chat', id: 'another' } })).toThrow('owner_mismatch');
    expect(() => parseAgentCoordinatorSnapshot({ ...snapshot, cursor: snapshot.cursor + 1 })).toThrow('invalid_snapshot');
    const wait = await restored.coordinator.wait([a.runId], snapshot.cursor, 0); expect(wait.runs[0]!.status).toBe('interrupted'); expect(wait.events.at(-1)?.status).toBe('interrupted');
    expect(parseAgentCoordinatorSnapshot(restored.coordinator.snapshot()).cursor).toBeGreaterThan(snapshot.cursor);
    await f.coordinator.close(); await restored.coordinator.close();
  });
  it('wait timeout does not cancel work, while the hard deadline stops it', async () => {
    const f = fixture({ limits: { deadline: Date.now() + 120, cancellationGraceMs: 5 } });
    const a = await f.coordinator.spawn(spec, 'a'); await running(f, 1);
    const cursor = f.coordinator.snapshot().cursor;
    const wait = await f.coordinator.wait([a.runId], cursor, 1);
    expect(wait.timedOut).toBe(true); expect(f.pending.get(a.runId)!.controls.signal.aborted).toBe(false);
    await terminal(f, a.taskId, 'timed_out'); expect(f.pending.get(a.runId)!.controls.signal.aborted).toBe(true);
    await f.coordinator.close();
  });

  it('does not start execution when saving the running checkpoint fails', async () => {
    const f = fixture({ checkpoint: async snapshot => { if (snapshot.tasks.some(task => task.runs.some(run => run.status === 'running'))) throw new Error('storage unavailable'); } });
    const a = await f.coordinator.spawn(spec, 'a'); await terminal(f, a.taskId, 'failed');
    expect(f.started).toHaveLength(0); expect(f.coordinator.get(a.taskId).runs[0]!.errorCode).toBe('checkpoint_failed');
    await f.coordinator.close();
  });

});
