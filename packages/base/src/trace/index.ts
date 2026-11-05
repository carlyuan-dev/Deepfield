import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
export * from "./content.js";

const Id = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:@+~-]*$" });
export const TraceContextSchema = Type.Object({ rootTraceId: Id, spanId: Id }, { additionalProperties: false });
export type TraceContext = Static<typeof TraceContextSchema>;
const common = {
  version: Type.Literal(1), eventId: Id, ...TraceContextSchema.properties,
  parentSpanId: Type.Optional(Id), links: Type.Optional(Type.Array(TraceContextSchema, { maxItems: 32 })),
  processSessionId: Id, sequence: Type.Integer({ minimum: 0 }),
  time: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
  requestId: Id,
};
const kinds = Type.Union([Type.Literal("request"), Type.Literal("worker"), Type.Literal("model"), Type.Literal("tool"), Type.Literal("interaction"), Type.Literal("action"), Type.Literal("task"), Type.Literal("stage")]);
const references = {
  conversationId: Type.Optional(Id), modelRequestId: Type.Optional(Id), executionId: Type.Optional(Id), toolCallId: Type.Optional(Id), toolName: Type.Optional(Id),
  turn: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })),
  phase: Type.Optional(Type.Union([Type.Literal("ordinary"), Type.Literal("synthesis"), Type.Literal("completion")])),
  capabilityId: Type.Optional(Id), actionId: Type.Optional(Id), invocationId: Type.Optional(Id), interactionId: Type.Optional(Id),
  receiptId: Type.Optional(Id), taskId: Type.Optional(Id), runId: Type.Optional(Id), artifactId: Type.Optional(Id),
  /** @deprecated Legacy research events; new producers use artifactId. */
  evidenceAttemptId: Type.Optional(Id),
  revision: Type.Optional(Type.Integer({ minimum: 0 })),
  // Stable capability-owned identifier, never a title or free-form payload.
  stage: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_.-]*$" })),
};
export const TraceStatusSchema = Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("timeout"), Type.Literal("interrupted"), Type.Literal("unknown"), Type.Literal("handed_off"), Type.Literal("skipped"), Type.Literal("reused"), Type.Literal("accepted"), Type.Literal("invalidated")]);
export const TracePendingStatusSchema = Type.Union([Type.Literal("waiting"), Type.Literal("editing"), Type.Literal("executing"), Type.Literal("queued"), Type.Literal("running"), Type.Literal("paused")]);
export const TraceEventSchema = Type.Union([
  Type.Object({ ...common, ...references, type: Type.Literal("span.start"), kind: kinds }, { additionalProperties: false }),
  Type.Object({ ...common, ...references, type: Type.Literal("span.end"), kind: kinds, status: TraceStatusSchema,
    errorCode: Type.Optional(Type.Union([Type.Literal("execution_failed"), Type.Literal("no_terminal"), Type.Literal("transport_failed"), Type.Literal("audit_failed"), Type.Literal("aborted"), Type.Literal("deadline"), Type.Literal("process_exit")])),
  }, { additionalProperties: false }),
  Type.Object({ ...common, ...references, type: Type.Literal("span.state"), kind: kinds, status: TracePendingStatusSchema }, { additionalProperties: false }),
  Type.Object({ ...common, type: Type.Literal("span.link"), links: Type.Array(TraceContextSchema, { minItems: 1, maxItems: 32 }) }, { additionalProperties: false }),
  Type.Object({ ...common, type: Type.Literal("coverage.gap"), reason: Type.Literal("association_missing") }, { additionalProperties: false }),
  Type.Object({ ...common, type: Type.Literal("usage.link"), usageAttemptId: Id, modelRequestId: Type.Optional(Id),
    serviceKind: Type.Union([Type.Literal("llm"), Type.Literal("search")]),
  }, { additionalProperties: false }),
]);
export type TraceEvent = Static<typeof TraceEventSchema>;
export type TraceStatus = Static<typeof TraceStatusSchema>;
export type TraceKind = Extract<TraceEvent, { type: "span.start" }>["kind"];
export type TraceReferences = Omit<Extract<TraceEvent, { type: "span.start" }>, keyof Static<typeof TraceContextSchema> | keyof typeof common | "type" | "kind">;
export interface TraceScope extends TraceContext { requestId: string; modelRequestId?: string }
export interface TraceRef { kind: "request" | "interaction" | "invocation" | "task" | "run"; id: string; capabilityId?: string }
export interface TraceSpan {
  context: TraceScope;
  state(status: Static<typeof TracePendingStatusSchema>, references?: Pick<TraceReferences, "revision" | "receiptId">): void;
  end(status: TraceStatus, errorCode?: Extract<TraceEvent, { type: "span.end" }>["errorCode"]): void;
}
/** Optional host-owned functions: portable packages never load a collector or ALS. */
export interface TracePort {
  readonly version: 1;
  capture(): TraceScope | undefined;
  run<T>(scope: TraceScope | undefined, work: () => T): T;
  start(kind: TraceKind, requestId: string, references?: TraceReferences, parent?: TraceScope | null): TraceSpan;
  link(scope: TraceScope, links: readonly (TraceContext | undefined)[]): void;
  find(ref: TraceRef): TraceScope | undefined;
  dispose(): void;
}
export function parseTraceEvent(value: unknown): TraceEvent {
  if (!Value.Check(TraceEventSchema, value) || !Number.isFinite(Date.parse(value.time)) || new Date(value.time).toISOString() !== value.time) throw new Error("invalid_trace_event");
  const serialized = JSON.stringify(value);
  if (serialized.length > 8192) throw new Error("trace_event_too_large");
  return JSON.parse(serialized) as TraceEvent;
}
export interface TraceHealth { pending: number; failed: number; dropped: number; lastErrorCode: "invalid_event" | "sink_failed" | "queue_full" | "closed" | "flush_timeout" | null }
export function parseTraceHealth(value: unknown): TraceHealth {
  const record = value as TraceHealth;
  if (!record || typeof record !== "object" || Object.keys(record).sort().join() !== "dropped,failed,lastErrorCode,pending" ||
    ![record.pending, record.failed, record.dropped].every(n => Number.isSafeInteger(n) && n >= 0) ||
    ![null, "invalid_event", "sink_failed", "queue_full", "closed", "flush_timeout"].includes(record.lastErrorCode)) throw new Error("invalid_trace_health");
  return { ...record };
}
export interface TraceCollector { emit(event: unknown): void; health(): TraceHealth; close(timeoutMs?: number): Promise<void> }
