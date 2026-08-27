import type { ToolFailure, ToolFailureCode, ToolFailureMetadata } from "./errors.js";

/** Injectable virtual clock: `wait` must be cancellable via the signal. */
export interface RetryClock {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

/** Controlled 5xx responses that are safe to retry. */
const RETRYABLE_5XX = new Set([500, 502, 503, 504]);

export function isRetryableFailure(code: ToolFailureCode, httpStatus?: number): boolean {
  if (code === "rate_limited") {
    return true; // 429
  }
  if (code === "network_unavailable") {
    return true; // transient network
  }
  if (code === "timeout") {
    return httpStatus === 408; // request timeout is explicitly allowed
  }
  if (code === "executor_failed" && httpStatus !== undefined) {
    return RETRYABLE_5XX.has(httpStatus);
  }
  return false;
}

export function httpStatusFromMetadata(
  metadata: Readonly<ToolFailureMetadata> | undefined,
): number | undefined {
  const status = metadata?.httpStatus;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

export function httpStatusOf(failure: ToolFailure): number | undefined {
  return httpStatusFromMetadata(failure.metadata);
}
