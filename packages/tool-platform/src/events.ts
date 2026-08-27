import type { ToolExecutionEvent, ToolIdentity } from "@deepfield/contracts";
import type { ToolFailure } from "./errors.js";

export type ToolEventSink = (event: ToolExecutionEvent) => void;

export type ToolEventDraft =
  | { type: "accepted" }
  | { type: "validated" }
  | { type: "policy_checked" }
  | { type: "started" }
  | { type: "progress"; progress: Record<string, unknown> }
  | { type: "retry_scheduled"; retryDelayMs: number }
  | { type: "completed" }
  | { type: "failed"; failure: ToolFailure }
  | { type: "cancelled"; failure: ToolFailure };

/** Builds correlated events with a monotonic sequence and isolated delivery. */
export class ToolEventEmitter {
  #sequence = -1;

  constructor(
    readonly executionId: string,
    readonly traceId: string,
    readonly tool: ToolIdentity,
    readonly now: () => number,
    readonly onEvent: ToolEventSink,
  ) {}

  emit(draft: ToolEventDraft): void {
    this.#sequence += 1;
    const event = {
      executionId: this.executionId,
      traceId: this.traceId,
      tool: this.tool,
      sequence: this.#sequence,
      timestamp: this.now(),
      ...draft,
    } as unknown as ToolExecutionEvent;
    try {
      this.onEvent(event);
    } catch {
      // Isolated delivery: a throwing listener must not cause a double
      // terminal or leak the raw listener error to the caller.
    }
  }
}

/**
 * Converts arbitrary executor progress into a whitelisted, JSON-safe structure.
 * Only `kind`, `message`, `bytes` and `percent` survive; non-finite numbers,
 * BigInt, functions and unknown fields are dropped so a malicious progress
 * payload cannot smuggle secrets or non-JSON values out.
 */
export function toSafeProgress(progress: unknown): Record<string, unknown> {
  if (typeof progress !== "object" || progress === null || Array.isArray(progress)) {
    return { kind: "progress" };
  }
  const record = progress as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  const kind = record["kind"];
  safe["kind"] = typeof kind === "string" && kind.length > 0 ? kind : "progress";
  if (typeof record["message"] === "string") {
    safe["message"] = record["message"];
  }
  if (
    typeof record["bytes"] === "number" &&
    Number.isFinite(record["bytes"]) &&
    record["bytes"] >= 0
  ) {
    safe["bytes"] = record["bytes"];
  }
  if (typeof record["percent"] === "number" && Number.isFinite(record["percent"])) {
    safe["percent"] = record["percent"];
  }
  return safe;
}
