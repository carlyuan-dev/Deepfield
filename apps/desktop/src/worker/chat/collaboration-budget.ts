import { withModelRequestAdmission } from "@deepfield/base/model/runtime";
import { AgentCollaborationError } from "@deepfield/base/agent/collaboration/runtime";
import { AsyncLocalStorage } from "node:async_hooks";

export function createCollaborationBudget(options: {
  modelCalls?: number; remainingMs?: number; maxRequests?: number;
  active?: boolean; now?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  const started = now();
  const duration = Math.max(0, Math.min(600_000, options.remainingMs ?? 600_000));
  const max = options.maxRequests ?? 32;
  let calls = options.modelCalls ?? 0;
  let active = options.active ?? false;
  let closed = false;
  const phase = new AsyncLocalStorage<{ final: boolean; rejection?: AgentCollaborationError }>();
  const controller = new AbortController();
  const workController = new AbortController();
  const remaining = () => Math.max(0, duration - (now() - started));
  const stopWork = () => { if (active) workController.abort(new Error("collaboration_finalization")); };
  const workTimer = setTimeout(stopWork, Math.max(0, duration - 60_000));
  workTimer.unref?.();
  if (active && duration <= 60_000) stopWork();
  const timer = setTimeout(() => { if (active) controller.abort(new Error("collaboration_deadline")); }, duration);
  timer.unref?.();
  const guard = (final: boolean) => {
    if (closed || controller.signal.aborted) throw new AgentCollaborationError("scope_closed");
    if (active && (remaining() === 0 || (!final && remaining() <= 60_000))) throw new AgentCollaborationError("deadline_exceeded");
    if (active && calls >= max - (final ? 0 : 1)) throw new AgentCollaborationError("model_budget_exceeded");
    calls++;
  };
  const enter = <T>(final: boolean, work: () => T): T => {
    const nested = phase.getStore() !== undefined;
    const context: { final: boolean; rejection?: AgentCollaborationError } = { final };
    return phase.run(context, () => {
      const invoke = () => {
        try {
          const value = work();
          if (value instanceof Promise) return value.catch(error => { throw context.rejection ?? error; }) as T;
          return value;
        } catch (error) { throw context.rejection ?? error; }
      };
      return nested ? invoke() : withModelRequestAdmission(() => {
        const current = phase.getStore()!;
        try { guard(current.final); }
        catch (error) { if (error instanceof AgentCollaborationError) current.rejection = error; throw error; }
      }, invoke);
    });
  };
  return {
    activate() {
      active = true;
      if (remaining() <= 60_000) stopWork();
      if (remaining() === 0) controller.abort(new Error("collaboration_deadline"));
    },
    run<T>(work: () => T): T { return enter(false, work); },
    final<T>(work: () => T): T { return enter(true, work); },
    get shouldFinalize() { return active && (calls >= max - 1 || remaining() <= 60_000); },
    snapshot() { return { modelCalls: calls, remainingMs: remaining() }; },
    signal: controller.signal,
    workSignal: workController.signal,
    close() { closed = true; clearTimeout(timer); clearTimeout(workTimer); },
  };
}
