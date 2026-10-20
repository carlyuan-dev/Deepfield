export * from "./contracts.js";
export { ToolExecutionError, makeToolFailure, TOOL_FAILURE_MESSAGES, type ToolFailureCode, type ToolFailureMetadata, type ToolFailure as ClassifiedToolFailure } from "./errors.js";
export type * from "./definition.js";
export type * from "./budget-contract.js";
export type { ToolBudgetLimits, ToolBudgetToken } from "./budget.js";
export type { ToolAuditStart, ToolAuditFinish, ToolAuditSink } from "./audit.js";
export type { ToolGrant } from "./tool-set.js";
export type { ToolEventSink, SafeProgress, ProgressKind } from "./events.js";
export type { RetryClock } from "./retry.js";

/** Narrow same-database audit cleanup supplied by the trusted host. */
export interface ToolsAuditService { readonly version: 1; deleteByTraceIds(traceIds: readonly string[]): number }
export function assertToolsAuditService(value: unknown): asserts value is ToolsAuditService {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("deleteByTraceIds" in value) || typeof value.deleteByTraceIds !== "function") throw new Error("incompatible_host_service:tools.audit.v1");
}
