import type { ToolExecutionEvent, ToolIdentity } from "@deepfield/contracts";
import type { ToolFailure } from "./errors.js";

export type ToolEventSink = (event: ToolExecutionEvent) => void;

export type ProgressKind = "searching" | "checking" | "fetching" | "parsing" | "progress";

const PROGRESS_KINDS: ReadonlySet<string> = new Set([
  "searching",
  "checking",
  "fetching",
  "parsing",
  "progress",
]);

export interface SafeProgress {
  readonly kind: ProgressKind;
  readonly bytes?: number;
  readonly percent?: number;
}

/**
 * Converts arbitrary executor progress into a whitelisted, JSON-safe,
 * deep-frozen structure. Only the controlled kind plus non-negative integer
 * bytes and 0..100 percent survive; free-form strings (including any message
 * the executor might smuggle) and unknown kinds are dropped or downgraded.
 */
export function toSafeProgress(progress: unknown): SafeProgress {
  if (typeof progress !== "object" || progress === null || Array.isArray(progress)) {
    return Object.freeze({ kind: "progress" });
  }
  const record = progress as Record<string, unknown>;
  const rawKind = record["kind"];
  const kind: ProgressKind =
    typeof rawKind === "string" && PROGRESS_KINDS.has(rawKind)
      ? (rawKind as ProgressKind)
      : "progress";
  const bytes = record["bytes"];
  const percent = record["percent"];
  return Object.freeze({
    kind,
    ...(typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 0 ? { bytes } : {}),
    ...(typeof percent === "number" &&
    Number.isFinite(percent) &&
    percent >= 0 &&
    percent <= 100
      ? { percent }
      : {}),
  });
}

export type ToolEventDraft =
  | { type: "accepted" }
  | { type: "validated" }
  | { type: "policy_checked" }
  | { type: "started" }
  | { type: "progress"; progress: SafeProgress }
  | { type: "retry_scheduled"; retryDelayMs: number }
  | { type: "completed" }
  | { type: "failed"; failure: ToolFailure }
  | { type: "cancelled"; failure: ToolFailure };

/**
 * Builds correlated, immutable events with a monotonic sequence and isolated
 * delivery. The event and every nested payload (tool, failure, progress) are
 * frozen snapshots: a listener's assignment/delete cannot change the Runner.
 */
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
    const event = Object.freeze({
      executionId: this.executionId,
      traceId: this.traceId,
      tool: this.tool,
      sequence: this.#sequence,
      timestamp: this.now(),
      ...draft,
    } as unknown as ToolExecutionEvent);
    try {
      this.onEvent(event);
    } catch {
      // Isolated delivery: a throwing listener must not cause a double
      // terminal or leak the raw listener error to the caller.
    }
  }
}
