import type { ToolExecutionResult, ToolIdentity } from "@deepfield/contracts";
import type { ToolBudgetLedger, ToolBudgetToken } from "./budget.js";
import type { RetryClock } from "./retry.js";
import type { ToolAuditSink } from "./audit.js";
import { makeToolFailure } from "./errors.js";
import type { ToolConcurrencyLimiter } from "./limiter.js";
import type { ToolMeterCategory } from "./definition.js";
import { ToolPolicy } from "./policy.js";
import { ToolRegistry } from "./registry.js";

export interface ToolRunnerOptions {
  registry: ToolRegistry;
  policy: ToolPolicy;
  budget: ToolBudgetLedger;
  audit: ToolAuditSink;
  clock: RetryClock;
  /** Per-trace budget resolution: called once per execution by trusted traceId. */
  budgetForTrace?: (traceId: string) => ToolBudgetLedger;
  /** Process-wide concurrency cap across all traces (0/undefined = unlimited). */
  globalConcurrency?: number;
  /**
   * Hard per-identity concurrency cap for network tools (meter.category !=
   * "none"): effective limit = min(definition.concurrency, this cap), applied
   * per name@version so different network tools never share one slot.
   */
  networkToolConcurrency?: number;
}

export const GLOBAL_CONCURRENCY_KEY = "__global__";

// Only reachable for out-of-contract calls; safe invalid_input with a frozen
// placeholder so no mutable caller object is ever exposed.
export const INVALID_TOOL_PLACEHOLDER: ToolIdentity = Object.freeze({
  name: "invalid_tool",
  version: 1,
});
export const INVALID_EXECUTION_ID = "invalid-execution";
export const INVALID_TRACE_ID = "invalid-trace";

export function invalidInputPlaceholder(): ToolExecutionResult {
  return {
    executionId: INVALID_EXECUTION_ID,
    traceId: INVALID_TRACE_ID,
    tool: INVALID_TOOL_PLACEHOLDER,
    status: "failed",
    failure: makeToolFailure("invalid_input", 1, false),
    attempts: 1,
  };
}

export interface ExecutionSlots {
  token: ToolBudgetToken;
  releaseGlobal: () => void;
  releaseTool: () => void;
}

/**
 * Atomically acquires the global slot, the per-trace budget token and the
 * per-tool-identity concurrency slot. Network tools (category != "none") are
 * additionally capped by networkToolConcurrency per identity — different
 * network tools never share one slot. Returns undefined on any saturation so
 * the caller can fail with a safe budget_exceeded.
 */
export function acquireExecutionSlots(
  concurrency: ToolConcurrencyLimiter,
  options: {
    globalConcurrency?: number;
    networkToolConcurrency?: number;
    ledger: ToolBudgetLedger;
    tool: ToolIdentity;
    category: ToolMeterCategory;
    definitionConcurrency: number;
  },
): ExecutionSlots | undefined {
  const releaseGlobal =
    options.globalConcurrency !== undefined
      ? concurrency.acquire(GLOBAL_CONCURRENCY_KEY, options.globalConcurrency)
      : undefined;
  if (options.globalConcurrency !== undefined && releaseGlobal === undefined) {
    return undefined;
  }
  let token: ToolBudgetToken;
  try {
    token = options.ledger.reserve(options.tool, options.category);
  } catch {
    releaseGlobal?.();
    return undefined;
  }
  const toolLimit =
    options.category !== "none" && options.networkToolConcurrency !== undefined
      ? Math.min(options.definitionConcurrency, options.networkToolConcurrency)
      : options.definitionConcurrency;
  const releaseTool = concurrency.acquire(
    `${options.tool.name}@${options.tool.version}`,
    toolLimit,
  );
  if (releaseTool === undefined) {
    options.ledger.release(token);
    releaseGlobal?.();
    return undefined;
  }
  return {
    token,
    releaseGlobal: () => releaseGlobal?.(),
    releaseTool: () => releaseTool(),
  };
}
