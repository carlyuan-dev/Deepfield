import { Value } from "typebox/value";
import { AgentWorkerRequestSchema, LlmRuntimeSnapshotSchema, SearchRuntimeSnapshotSchema } from "@deepfield/contracts";
import { CapabilityWorkerRequestSchema } from "@deepfield/capability-sdk";
import type { TraceContentMode, TraceContentRecord } from "@deepfield/base/trace";
import type { createTraceContentCollector } from "@deepfield/base/trace/runtime";

/** Startup-only, explicit request allowlist. Invalid configuration is off. */
export function traceContentPolicyFromEnvironment(raw: string | undefined): (requestId: string) => TraceContentMode | undefined {
  try {
    if (!raw || raw.length > 210000) return () => undefined;
    const policy = JSON.parse(raw);
    if (!policy || Object.keys(policy).sort().join() !== "mode,requestIds" || !["benchmark", "diagnostic"].includes(policy.mode) ||
        !Array.isArray(policy.requestIds) || policy.requestIds.length > 1000 || policy.requestIds.some((id: unknown) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]{0,199}$/.test(id))) return () => undefined;
    const ids = new Set<string>(policy.requestIds); const mode = policy.mode as TraceContentMode;
    return requestId => ids.has(requestId) ? mode : undefined;
  } catch { return () => undefined; }
}

export interface TraceContentHost {
  modeFor(requestId: string): TraceContentMode | undefined;
  record(serialized: string): unknown;
}

/** Reads only runtime snapshot fields from a trusted dispatch, never a worker's claimed keys. */
export function traceContentRequestSecrets(value: unknown): readonly string[] {
  if (!value || typeof value !== "object") return [];
  const request = value as { kind?: string; input?: unknown; llm?: unknown; search?: unknown };
  const input = request.kind === "capability.run" ? request.input : request;
  if (!input || typeof input !== "object") return [];
  const snapshots = input as { llm?: unknown; search?: unknown };
  return [...(Value.Check(LlmRuntimeSnapshotSchema, snapshots.llm) ? [snapshots.llm.apiKey] : []), ...(Value.Check(SearchRuntimeSnapshotSchema, snapshots.search) ? [snapshots.search.apiKey] : [])];
}

/** Main independently fails closed on known credentials or unredacted credential fields. */
export function traceContentCredentialSafe(record: TraceContentRecord, secrets: readonly string[]): boolean {
  let nodes = 0;
  function safe(value: unknown, depth: number): boolean {
    if (++nodes > 100000 || depth > 64) return false;
    if (typeof value === "string") return !secrets.some(secret => secret && value.includes(secret));
    if (!value || typeof value !== "object") return true;
    return Object.entries(value).every(([key, child]) => safe(key, depth + 1) &&
      (/^(?:api[-_]?key|authorization|proxy[-_]?authorization|password|passwd|secret|access[-_]?token|refresh[-_]?token|cookie|set[-_]?cookie)$/i.test(key) ? child === "[REDACTED]" : safe(child, depth + 1)));
  }
  return safe(record, 0);
}

/** Only the trusted parent transport calls this. Never accepts renderer policy. */
export function unwrapTraceContentRun(value: unknown, collector: ReturnType<typeof createTraceContentCollector>): unknown {
  if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== "trace.content.run") return value;
  const envelope = value as { kind: string; mode?: unknown; request?: unknown };
  if (Object.keys(envelope).sort().join() !== "kind,mode,request" || !["benchmark", "diagnostic"].includes(String(envelope.mode))) return undefined;
  const request = envelope.request;
  if (!Value.Check(AgentWorkerRequestSchema, request) && !Value.Check(CapabilityWorkerRequestSchema, request)) return undefined;
  if (!request.trace) return undefined;
  const secrets = traceContentRequestSecrets(request);
  collector.authorize(request.requestId, request.trace.rootTraceId, envelope.mode as TraceContentMode, secrets);
  return request;
}
