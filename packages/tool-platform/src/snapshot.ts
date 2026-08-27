import type { ToolIdentity } from "@deepfield/contracts";
import type { ToolActor } from "./definition.js";

/** Frozen scope handed to executors: no ToolSet/confirmations abuse surface. */
export interface ExecutorScope {
  readonly traceId: string;
  readonly actor: ToolActor;
  readonly projectId?: string;
}

const TOOL_ACTORS = new Set([
  "main_agent",
  "capability",
  "child_agent",
  "direct_ui",
  "developer_probe",
] as const);

export function snapshotToolIdentity(identity: unknown): ToolIdentity | undefined {
  if (typeof identity !== "object" || identity === null) {
    return undefined;
  }
  const record = identity as Record<string, unknown>;
  if (typeof record["name"] !== "string" || record["name"].trim().length === 0) {
    return undefined;
  }
  if (!Number.isInteger(record["version"]) || (record["version"] as number) < 1) {
    return undefined;
  }
  return Object.freeze({ name: record["name"] as string, version: record["version"] as number });
}

export function snapshotScope(input: {
  traceId: unknown;
  actor: unknown;
  projectId?: unknown;
}): ExecutorScope | undefined {
  if (typeof input.traceId !== "string" || input.traceId.length === 0) {
    return undefined;
  }
  if (typeof input.actor !== "string" || !TOOL_ACTORS.has(input.actor as ToolActor)) {
    return undefined;
  }
  return Object.freeze({
    traceId: input.traceId,
    actor: input.actor as ToolActor,
    ...(typeof input.projectId === "string" && input.projectId.length > 0
      ? { projectId: input.projectId }
      : {}),
  });
}

/**
 * JSON-safe deep snapshot of the call input. The copy keeps every JSON field
 * (no stringify/parse that could silently drop data), rejects undefined/
 * function/symbol/bigint/NaN/Infinity/circular values, and deep-freezes the
 * result so policy, validation and the executor all see one immutable value.
 */
export function snapshotInput(input: unknown): unknown {
  const copy = deepCopyJson(input, new WeakSet<object>());
  if (copy === undefined) {
    return undefined;
  }
  return deepFreezeJson(copy);
}

function deepCopyJson(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object") {
    return undefined; // function / symbol / bigint / undefined
  }
  if (seen.has(value)) {
    return undefined; // circular or shared reference: not JSON-representable
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const copied = deepCopyJson(item, seen);
      if (copied === undefined && item !== null) {
        return undefined;
      }
      result.push(copied);
    }
    return result;
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const copied = deepCopyJson(record[key], seen);
    if (copied === undefined && record[key] !== null) {
      return undefined;
    }
    result[key] = copied;
  }
  return result;
}

function deepFreezeJson(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreezeJson((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value as object);
}
