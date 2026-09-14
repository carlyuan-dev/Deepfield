import type { ToolIdentity } from "@deepfield/contracts";
import type { ToolActor, ToolRunContext } from "./definition.js";
import type { ToolSet } from "./tool-set.js";

/** Frozen scope handed to executors: no ToolSet/confirmations abuse surface. */
export interface ExecutorScope {
  readonly traceId: string;
  readonly actor: ToolActor;
  readonly projectId?: string;
  readonly agentTurnIndex?: number;
  readonly batchId?: string;
  readonly toolCallId?: string;
  /** Immutable ToolSet authorization fingerprint (stable string). */
  readonly toolSetFingerprint?: string;
}

/**
 * Entry snapshot used by Policy: ToolSet is immutable so its reference is
 * safe, while confirmations are copied so later add/delete on the original
 * set cannot change this execution's authorization.
 */
export interface PolicyContextSnapshot {
  readonly traceId: string;
  readonly actor: ToolActor;
  readonly projectId?: string;
  readonly toolSet?: ToolSet;
  readonly confirmations?: ReadonlySet<string>;
}

export type JsonSnapshotResult<T = unknown> = { ok: true; value: T } | { ok: false };

export interface CorrelationSnapshot {
  executionId: string;
  traceId: string;
}

/**
 * Validates the correlation IDs of a call. Only non-empty strings are usable:
 * out-of-contract values are never echoed back and produce a fixed safe
 * placeholder result instead.
 */
export function snapshotCorrelation(call: {
  executionId: unknown;
  traceId: unknown;
}): CorrelationSnapshot | undefined {
  if (typeof call.executionId !== "string" || call.executionId.length === 0) {
    return undefined;
  }
  if (typeof call.traceId !== "string" || call.traceId.length === 0) {
    return undefined;
  }
  return { executionId: call.executionId, traceId: call.traceId };
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
  agentTurnIndex?: unknown;
  batchId?: unknown;
  toolCallId?: unknown;
  toolSetFingerprint?: unknown;
}): ExecutorScope | undefined {
  if (typeof input.traceId !== "string" || input.traceId.length === 0) {
    return undefined;
  }
  if (typeof input.actor !== "string" || !TOOL_ACTORS.has(input.actor as ToolActor)) {
    return undefined;
  }
  if (input.agentTurnIndex !== undefined && (!Number.isInteger(input.agentTurnIndex) || (input.agentTurnIndex as number) < 0)) {
    return undefined;
  }
  if (input.batchId !== undefined && (typeof input.batchId !== "string" || input.batchId.length === 0)) {
    return undefined;
  }
  if (input.toolCallId !== undefined && (typeof input.toolCallId !== "string" || input.toolCallId.length === 0)) {
    return undefined;
  }
  return Object.freeze({
    traceId: input.traceId,
    actor: input.actor as ToolActor,
    ...(typeof input.projectId === "string" && input.projectId.length > 0
      ? { projectId: input.projectId }
      : {}),
    ...(input.agentTurnIndex !== undefined ? { agentTurnIndex: input.agentTurnIndex as number } : {}),
    ...(typeof input.batchId === "string" ? { batchId: input.batchId } : {}),
    ...(typeof input.toolCallId === "string" ? { toolCallId: input.toolCallId } : {}),
    ...(typeof input.toolSetFingerprint === "string" && input.toolSetFingerprint.length > 0
      ? { toolSetFingerprint: input.toolSetFingerprint }
      : {}),
  });
}

export function snapshotPolicyContext(
  context: ToolRunContext,
): PolicyContextSnapshot | undefined {
  if (typeof context.traceId !== "string" || context.traceId.length === 0) {
    return undefined;
  }
  if (typeof context.actor !== "string" || !TOOL_ACTORS.has(context.actor as ToolActor)) {
    return undefined;
  }
  const confirmations =
    context.confirmations === undefined ? undefined : new Set(context.confirmations);
  return Object.freeze({
    traceId: context.traceId,
    actor: context.actor as ToolActor,
    ...(typeof context.projectId === "string" && context.projectId.length > 0
      ? { projectId: context.projectId }
      : {}),
    ...(context.toolSet !== undefined ? { toolSet: context.toolSet } : {}),
    ...(confirmations !== undefined ? { confirmations } : {}),
  });
}

export interface ExecutionSnapshot {
  input: unknown;
  scope: ExecutorScope;
  policyContext: PolicyContextSnapshot;
}

/**
 * Captures every pipeline input (input value, executor scope, policy context)
 * before the first emit/await. Returns undefined when any capture fails or the
 * context trace does not match the call trace; the Runner maps that to a safe
 * invalid_input. A listener running on the first event cannot change any of
 * these captured values.
 */
export function snapshotExecutionInput(
  call: { input: unknown },
  context: ToolRunContext,
  traceId: string,
): ExecutionSnapshot | undefined {
  const inputResult = snapshotJsonValue(call.input);
  if (!inputResult.ok) {
    return undefined;
  }
  const scope = snapshotScope({
    traceId: context.traceId,
    actor: context.actor,
    projectId: context.projectId,
    agentTurnIndex: context.agentTurnIndex,
    batchId: context.batchId,
    toolCallId: context.toolCallId,
    toolSetFingerprint: context.toolSet?.fingerprint(),
  });
  if (scope === undefined || scope.traceId !== traceId) {
    return undefined;
  }
  const policyContext = snapshotPolicyContext(context);
  if (policyContext === undefined) {
    return undefined;
  }
  return { input: inputResult.value, scope, policyContext };
}

/**
 * JSON-safe deep snapshot of an input/output value: tagged success/failure so
 * `undefined` is never a fuzzy sentinel. The copy keeps every enumerable
 * string key (no stringify/parse that could silently drop fields), rejects
 * undefined/function/symbol/bigint/NaN/Infinity/true cycles/non-plain
 * objects/accessors/symbol keys, allows shared acyclic references, writes
 * keys like `__proto__` without touching prototypes, and deep-freezes the
 * result. Getters are never invoked; exotic objects that throw during
 * inspection map to failure.
 */
export function snapshotJsonValue(value: unknown): JsonSnapshotResult {
  try {
    const copy = copyJson(value, new Set<object>());
    if (copy === undefined) {
      return { ok: false };
    }
    return { ok: true, value: deepFreezeJson(copy) };
  } catch {
    return { ok: false };
  }
}

function copyJson(value: unknown, active: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object") {
    return undefined; // function / symbol / bigint / undefined
  }
  if (active.has(value)) {
    return undefined; // true cycle on the current copy path
  }
  if (Array.isArray(value)) {
    active.add(value);
    const result: unknown[] = [];
    for (const item of value) {
      const copied = copyJson(item, active);
      if (copied === undefined && item !== null) {
        active.delete(value);
        return undefined;
      }
      result.push(copied);
    }
    active.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined; // Date / Map / Set / class instance / RegExp / exotic
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return undefined; // symbol keys are not JSON
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  active.add(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      continue;
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      active.delete(value);
      return undefined; // accessor: reading it could execute code
    }
    if (!descriptor.enumerable) {
      continue;
    }
    const copied = copyJson(descriptor.value, active);
    if (copied === undefined && descriptor.value !== null) {
      active.delete(value);
      return undefined;
    }
    Object.defineProperty(result, key, {
      value: copied,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  active.delete(value);
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
