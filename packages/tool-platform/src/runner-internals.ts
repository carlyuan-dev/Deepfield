import type { ToolExecutionResult, ToolIdentity } from "@deepfield/contracts";
import type { ToolBudgetLedger } from "./budget.js";
import type { RetryClock } from "./retry.js";
import type { ToolAuditSink } from "./audit.js";
import { makeToolFailure } from "./errors.js";
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
