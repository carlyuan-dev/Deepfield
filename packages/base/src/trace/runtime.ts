import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
export { configureTraceContent, captureTraceContent, createTraceContentCollector } from "./content-runtime.js";
import { parseTraceEvent, type TraceCollector, type TraceContext, type TraceEvent, type TraceHealth, type TraceKind, type TracePort, type TraceReferences, type TraceRef, type TraceScope, type TraceSpan } from "./index.js";
export type { TraceScope, TraceSpan } from "./index.js";

export function createTraceCollector(sink: (event: TraceEvent) => unknown, options: { capacity?: number; timeoutMs?: number; onHealth?: (health: TraceHealth) => unknown } = {}): TraceCollector {
  const queue: TraceEvent[] = [];
  const state: TraceHealth = { pending: 0, failed: 0, dropped: 0, lastErrorCode: null };
  let draining = false; let closed = false; let closing = false;
  const idle = new Set<() => void>();
  let healthPublishing = false;
  let latestHealth: TraceHealth | undefined;
  function publishHealth() {
    latestHealth = { ...state };
    if (healthPublishing) return;
    healthPublishing = true;
    void (async () => {
      try { while (latestHealth) { const snapshot = latestHealth; latestHealth = undefined; try { await options.onHealth?.(snapshot); } catch { /* Optional notification. */ } } }
      finally { healthPublishing = false; }
    })();
  }
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !closed) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const event = queue[0]!;
        try {
          const result = await Promise.race([Promise.resolve().then(() => sink(event)), new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error("timeout")); }, options.timeoutMs ?? 750); })]);
          if (result === false) throw new Error("rejected");
        } catch { state.failed++; state.lastErrorCode = "sink_failed"; }
        finally { if (timer) clearTimeout(timer); }
        // A timed-out promise cannot be cancelled. Stop this collector so a
        // hanging sink cannot accumulate unbounded concurrent deliveries.
        if (timedOut) { closed = true; state.dropped += queue.length; queue.length = 0; }
        queue.shift(); state.pending = queue.length;
        publishHealth();
      }
    } finally { draining = false; for (const resolve of idle) resolve(); idle.clear(); }
  }
  return {
    emit(value) {
      let safe: TraceEvent;
      try { safe = parseTraceEvent(value); } catch { state.dropped++; state.lastErrorCode = "invalid_event"; publishHealth(); return; }
      if (closing || closed || queue.length >= (options.capacity ?? 2000)) { state.dropped++; state.lastErrorCode = closing || closed ? "closed" : "queue_full"; publishHealth(); return; }
      queue.push(safe); state.pending = queue.length; void drain();
    },
    health: () => ({ ...state }),
    async close(ms = 1500) {
      closing = true;
      let timer: ReturnType<typeof setTimeout> | undefined; let waiter: (() => void) | undefined;
      try { if (queue.length) await Promise.race([new Promise<void>(resolve => { waiter = resolve; idle.add(resolve); }), new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]); }
      finally { if (timer) clearTimeout(timer); if (waiter) idle.delete(waiter); }
      closed = true;
      if (queue.length) { state.dropped += queue.length; state.lastErrorCode = "flush_timeout"; queue.length = 0; state.pending = 0; }
      publishHealth();
    },
  };
}

const scopes = new AsyncLocalStorage<TraceScope | undefined>();
const processSessionId = randomUUID();
let sequence = 0;
let collector: TraceCollector | undefined;
let lookup: ((ref: TraceRef) => TraceScope | undefined) | undefined;
const recent = new Map<string, TraceScope>();
const refKey = (ref: TraceRef) => JSON.stringify([ref.capabilityId ?? "", ref.kind, ref.id]);
export function configureTraceLookup(value: typeof lookup): void { lookup = value; recent.clear(); }
export function findTrace(ref: TraceRef): TraceScope | undefined {
  try { const found = recent.get(refKey(ref)) ?? lookup?.(ref); return found ? { ...found } : undefined; } catch { return undefined; }
}
function remember(kind: TraceKind, references: TraceReferences, scope: TraceScope) {
  const ref: TraceRef | undefined = kind === "request" ? { kind: "request", id: scope.requestId }
    : kind === "interaction" && references.interactionId ? { kind: "interaction", id: references.interactionId }
    : kind === "action" && references.invocationId ? { kind: "invocation", id: references.invocationId, ...(references.capabilityId ? { capabilityId: references.capabilityId } : {}) }
    : kind === "task" && references.taskId ? { kind: "task", id: references.taskId, ...(references.capabilityId ? { capabilityId: references.capabilityId } : {}) }
    : kind === "stage" && references.runId ? { kind: "run", id: references.runId, ...(references.capabilityId ? { capabilityId: references.capabilityId } : {}) } : undefined;
  if (!ref) return;
  recent.set(refKey({ ...ref, ...(references.capabilityId ? { capabilityId: references.capabilityId } : {}) }), { ...scope });
  if (recent.size > 4000) recent.delete(recent.keys().next().value!);
}
export function configureTraceCollector(value: TraceCollector | undefined): void { collector = value; }
export function currentTrace(): TraceScope | undefined { return scopes.getStore(); }
export function withTrace<T>(scope: TraceScope | undefined, run: () => T): T { return scopes.run(scope, run); }
type Draft = Omit<Extract<TraceEvent, { type: "usage.link" }>, "version" | "eventId" | "processSessionId" | "sequence" | "time" | keyof TraceContext | "requestId">;
export function traceUsage(draft: Draft, scope = currentTrace()): void { if (scope) publish(scope, draft); }
function publish(scope: TraceScope, draft: object): void {
  try { collector?.emit({ ...draft, ...scope, version: 1, eventId: randomUUID(), processSessionId, sequence: ++sequence, time: new Date().toISOString() }); } catch { /* Optional observation cannot affect execution. */ }
}
export function traceLinks(scope: TraceScope, links: readonly (TraceContext | undefined)[]): void {
  if (links.some(link => !link)) publish(scope, { type: "coverage.gap", reason: "association_missing" });
  const unique = [...new Map(links.flatMap(link => link ? [[`${link.rootTraceId}:${link.spanId}`, { rootTraceId: link.rootTraceId, spanId: link.spanId }] as const] : [])).values()];
  for (let offset = 0; offset < unique.length; offset += 32) publish(scope, { type: "span.link", links: unique.slice(offset, offset + 32) });
}
export function startTraceSpan(kind: TraceKind, requestId: string, references: TraceReferences = {}, parent: TraceScope | null | undefined = currentTrace()): TraceSpan {
  const context: TraceScope = { rootTraceId: parent?.rootTraceId ?? randomUUID(), spanId: randomUUID(), requestId };
  const relation = parent ? { parentSpanId: parent.spanId } : {};
  publish(context, { type: "span.start", kind, ...references, ...relation });
  remember(kind, references, context);
  let ended = false;
  return { context,
    state(status, updates) { if (!ended) publish(context, { type: "span.state", kind, status, ...references,
      ...(updates?.revision === undefined ? {} : { revision: updates.revision }), ...(updates?.receiptId ? { receiptId: updates.receiptId } : {}), ...relation }); },
    end(status, errorCode) { if (ended) return; ended = true; publish(context, { type: "span.end", kind, status, ...references, ...relation, ...(errorCode ? { errorCode } : {}) }); } };
}

export function createTracePort(capabilityId?: string): TracePort {
  let disposed = false;
  return Object.freeze({ version: 1 as const,
    capture: () => disposed ? undefined : currentTrace() ? { ...currentTrace()! } : undefined,
    run: <T>(scope: TraceScope | undefined, work: () => T): T => withTrace(disposed ? undefined : scope, work),
    start(kind: TraceKind, requestId: string, references: TraceReferences = {}, parent?: TraceScope | null) {
      if (disposed) return { context: { rootTraceId: parent?.rootTraceId ?? randomUUID(), spanId: randomUUID(), requestId }, state() {}, end() {} };
      return startTraceSpan(kind, requestId, { ...references, ...(capabilityId ? { capabilityId } : {}) }, parent);
    },
    link(scope: TraceScope, links: readonly (TraceContext | undefined)[]) { if (!disposed) traceLinks(scope, links); },
    find(ref: TraceRef) { return disposed ? undefined : findTrace({ ...ref, ...(capabilityId ? { capabilityId } : {}) }); },
    dispose() { disposed = true; },
  });
}
