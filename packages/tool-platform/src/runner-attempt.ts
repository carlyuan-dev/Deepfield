import type { ToolDefinition, ToolProgress, ToolRunContext } from "./definition.js";
import { makeToolFailure, ToolExecutionError, type ToolFailure } from "./errors.js";
import { isRetryableFailure, type RetryClock } from "./retry.js";
import type { ToolAuditFinish, ToolAuditSink } from "./audit.js";

export type AttemptOutcome =
  | { kind: "value"; value: unknown }
  | { kind: "failure"; failure: ToolFailure }
  | { kind: "cancelled" }
  | { kind: "timeout" };

export interface RunAttemptOptions {
  definition: ToolDefinition<any, any>;
  input: unknown;
  context: ToolRunContext;
  controller: AbortController;
  remainingMs: number;
  attempts: number;
  clock: RetryClock;
  onProgress: (progress: ToolProgress) => void;
}

/**
 * Runs one executor attempt against the remaining deadline. The executor
 * invocation is deferred through Promise.resolve().then so synchronous throws,
 * non-Promise returns and throwing thenables are flattened into safe
 * rejections/resolutions: raw exceptions never escape the Runner, and the
 * budget/audit cleanup in the caller always runs.
 */
export async function runAttempt(options: RunAttemptOptions): Promise<AttemptOutcome> {
  const { definition, input, context, controller, remainingMs, attempts, clock, onProgress } =
    options;
  const executorPromise = Promise.resolve().then(() =>
    definition.execute(input as never, context, controller.signal, onProgress),
  );
  executorPromise.catch(() => {}); // suppress late rejection after the race settles
  try {
    const winner = await Promise.race([
      executorPromise.then((value) => ({ kind: "value" as const, value })),
      clock.wait(Math.max(0, remainingMs), controller.signal).then(() => "timeout" as const),
    ]);
    if (winner === "timeout") {
      controller.abort();
      return { kind: "timeout" };
    }
    return { kind: "value", value: winner.value };
  } catch (error) {
    if (controller.signal.aborted) {
      return { kind: "cancelled" };
    }
    return { kind: "failure", failure: classifyExecutorError(error, attempts) };
  }
}

export function classifyExecutorError(error: unknown, attempts: number): ToolFailure {
  if (error instanceof ToolExecutionError) {
    return makeToolFailure(
      error.code,
      attempts,
      isRetryableFailure(error.code, error.metadata?.httpStatus),
      error.metadata,
    );
  }
  return makeToolFailure("executor_failed", attempts, false);
}

export async function finishAuditBestEffort(
  audit: ToolAuditSink,
  record: ToolAuditFinish,
): Promise<void> {
  try {
    await audit.finish(record);
  } catch {
    // Already failing path: audit is best-effort here, never a success claim.
  }
}
