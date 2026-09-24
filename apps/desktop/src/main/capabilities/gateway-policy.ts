import { AppError, toPublicError } from "@deepfield/contracts";
import type { CapabilityRegistry } from "./registry.js";
export class GatewayError extends Error { constructor(readonly code: string) { super(code); } }
export function checkAccess(registry: CapabilityRegistry, capabilityId: string, required: readonly string[], context: { permissions: readonly string[] }): void {
  if (!registry.readyIds().includes(capabilityId)) throw new GatewayError("capability_unavailable");
  if (!required.every(permission => context.permissions.includes(permission))) throw new GatewayError("permission_denied");
}
const codes = new Set(["contract_changed", "permission_denied", "confirmation_invalid", "presentation_invalid", "revision_changed", "not_found", "expired", "reconciliation_required", "invocation_invalid", "response_too_large", "capability_unavailable"]);
export function safeGatewayError(error: unknown) {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code = typeof candidate === "string" && codes.has(candidate) ? candidate : toPublicError(typeof candidate === "string" ? new AppError(candidate as ConstructorParameters<typeof AppError>[0]) : error).code;
  return { code, message: code === "presentation_invalid" ? "无法安全展示确认内容，请检查操作参数。" : code, retryable: ["EXTERNAL.TIMEOUT", "EXTERNAL.UNAVAILABLE", "EXTERNAL.RATE_LIMITED"].includes(code),
    ...(code === "response_too_large" ? { recovery: "Request a smaller page or section." } : {}), ...(code === "reconciliation_required" ? { recovery: "Query the invocation receipt; do not resubmit the operation." } : {}) };
}
export function bounded<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new GatewayError("response_too_large");
  return JSON.parse(serialized) as T;
}

/** Canonical UTC timestamps only; absent/invalid/future completion falls back to observation. */
export function taskCompletionTime(finishedAt: string | undefined, observedAt: number): number {
  const parsed = finishedAt === undefined ? NaN : Date.parse(finishedAt);
  return Number.isFinite(parsed) && parsed <= observedAt && new Date(parsed).toISOString() === finishedAt ? parsed : observedAt;
}
