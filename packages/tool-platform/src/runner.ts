import { Value } from "typebox/value";
import type { ToolCallRequest, ToolExecutionResult } from "@deepfield/contracts";
import type { ToolBudgetLedger } from "./budget.js";
import type { ToolDefinition, ToolRunContext } from "./definition.js";
import { makeToolFailure, type ToolFailure, type ToolFailureCode } from "./errors.js";
import {
  ToolEventEmitter,
  type ToolEventDraft,
  type ToolEventSink,
  toSafeProgress,
} from "./events.js";
import { ToolPolicy } from "./policy.js";
import { ToolRegistry } from "./registry.js";
import { type RetryClock } from "./retry.js";
import type { ToolAuditSink } from "./audit.js";
import { finishAuditBestEffort, runAttempt } from "./runner-attempt.js";
import { ToolConcurrencyLimiter } from "./limiter.js";
import {
  snapshotCorrelation,
  snapshotExecutionInput,
  snapshotJsonValue,
  snapshotToolIdentity,
} from "./snapshot.js";
import {
  acquireExecutionSlots,
  invalidInputPlaceholder,
  type ToolRunnerOptions,
} from "./runner-internals.js";
export type { ToolRunnerOptions } from "./runner-internals.js";

/**
 * Single execution pipeline: entry snapshot -> resolve -> validate input ->
 * policy -> budget + concurrency -> audit start -> started -> execute/retry ->
 * validate output -> required audit finish + budget finalize -> one terminal.
 */
export class ToolRunner {
  readonly #registry: ToolRegistry;
  readonly #policy: ToolPolicy;
  readonly #budget: ToolBudgetLedger;
  readonly #budgetForTrace: ((traceId: string) => ToolBudgetLedger) | undefined;
  readonly #globalConcurrency: number | undefined;
  readonly #networkToolConcurrency: number | undefined;
  readonly #audit: ToolAuditSink;
  readonly #clock: RetryClock;
  readonly #concurrency: ToolConcurrencyLimiter;
  constructor(options: ToolRunnerOptions) {
    this.#registry = options.registry;
    this.#policy = options.policy;
    this.#budget = options.budget;
    this.#budgetForTrace = options.budgetForTrace;
    this.#globalConcurrency = options.globalConcurrency;
    this.#networkToolConcurrency = options.networkToolConcurrency;
    this.#audit = options.audit;
    this.#clock = options.clock;
    this.#concurrency = new ToolConcurrencyLimiter();
  }

  async execute(
    call: ToolCallRequest,
    context: ToolRunContext,
    signal: AbortSignal,
    onEvent: ToolEventSink,
  ): Promise<ToolExecutionResult> {
    const tool = snapshotToolIdentity(call.tool);
    const correlation = snapshotCorrelation(call);
    if (tool === undefined || correlation === undefined) {
      return invalidInputPlaceholder();
    }
    const { executionId, traceId } = correlation;
    // Capture everything before the first emit (accepted listeners must not
    // change actor, project, trace, toolSet or confirmations).
    const entry = snapshotExecutionInput(call, context, traceId);
    const startedAt = this.#clock.now();
    const emitter = new ToolEventEmitter(executionId, traceId, tool, () => this.#clock.now(), onEvent);
    let settled = false;
    let result: ToolExecutionResult | undefined;

    const emit = (draft: ToolEventDraft): void => {
      if (settled) {
        return;
      }
      emitter.emit(draft);
    };
    const settle = (next: ToolExecutionResult): ToolExecutionResult => {
      if (settled) {
        return result as ToolExecutionResult;
      }
      settled = true;
      result = next;
      return result;
    };
    // Single-line result builders keep this hot-path file under 300 lines.
    const fail = (failure: ToolFailure, budgetConsumed = false): ToolExecutionResult => {
      emit({ type: "failed", failure });
      return settle({ executionId, traceId, tool, status: "failed", failure, attempts: failure.attempts, budgetConsumed, durationMs: this.#clock.now() - startedAt });
    };
    const cancel = (failure: ToolFailure, budgetConsumed = false): ToolExecutionResult => {
      emit({ type: "cancelled", failure });
      return settle({ executionId, traceId, tool, status: "cancelled", failure, attempts: failure.attempts, budgetConsumed, durationMs: this.#clock.now() - startedAt });
    };
    const complete = (output: unknown, attempts: number, budgetConsumed: boolean): ToolExecutionResult => {
      emit({ type: "completed" });
      return settle({ executionId, traceId, tool, status: "completed", output: output as never, attempts, budgetConsumed, durationMs: this.#clock.now() - startedAt });
    };

    emit({ type: "accepted" });
    if (entry === undefined) {
      return fail(makeToolFailure("invalid_input", 1, false));
    }
    const { input, scope, policyContext } = entry;
    let definition: ToolDefinition<any, any>;
    try {
      definition = this.#registry.resolve(tool);
    } catch {
      return fail(makeToolFailure("tool_not_found", 1, false));
    }
    if (!Value.Check(definition.inputSchema, input)) {
      return fail(makeToolFailure("invalid_input", 1, false));
    }
    emit({ type: "validated" });

    const decision = this.#policy.evaluate(
      { identity: tool, effect: definition.effect, input: input as Record<string, unknown> },
      policyContext,
    );
    if (decision.decision === "deny") {
      return fail(makeToolFailure(decision.code, 1, false));
    }
    if (decision.decision === "confirmation_required") {
      return fail(makeToolFailure("confirmation_required", 1, false));
    }
    emit({ type: "policy_checked" });

    let ledger: ToolBudgetLedger;
    try {
      ledger =
        this.#budgetForTrace !== undefined ? this.#budgetForTrace(scope.traceId) : this.#budget;
    } catch {
      // A budget resolver failure (e.g. trace pool at capacity) is a safe
      // budget_exceeded, never an unhandled rejection or a generic tool_error.
      return fail(makeToolFailure("budget_exceeded", 1, false));
    }
    const slots = acquireExecutionSlots(this.#concurrency, {
      ...(this.#globalConcurrency !== undefined
        ? { globalConcurrency: this.#globalConcurrency }
        : {}),
      ...(this.#networkToolConcurrency !== undefined
        ? { networkToolConcurrency: this.#networkToolConcurrency }
        : {}),
      ledger,
      tool,
      effect: definition.effect,
      category: definition.meter.category,
      definitionConcurrency: definition.concurrency,
    });
    if (slots === undefined) {
      return fail(makeToolFailure("budget_exceeded", 1, false));
    }
    const { token, releaseGlobal, releaseTool: releaseConcurrency } = slots;
    let budgetConsumed = false;
    const markBudgetConsumed = (): void => {
      if (budgetConsumed) return;
      ledger.commit(token);
      budgetConsumed = true;
    };
    try {
      await this.#audit.start({
        executionId,
        traceId,
        ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
        actor: scope.actor,
        tool,
        attempts: 0,
        ...(scope.agentTurnIndex !== undefined ? { agentTurnIndex: scope.agentTurnIndex } : {}),
        ...(scope.batchId !== undefined ? { batchId: scope.batchId } : {}),
        ...(scope.toolCallId !== undefined ? { toolCallId: scope.toolCallId } : {}),
      });
    } catch {
      ledger.release(token);
      releaseConcurrency();
      releaseGlobal();
      return fail(makeToolFailure("audit_failed", 1, false));
    }

    if (signal.aborted) {
      ledger.release(token);
      releaseConcurrency();
      releaseGlobal();
      await finishAuditBestEffort(this.#audit, {
        executionId,
        traceId,
        status: "cancelled",
        attempts: 1,
        budgetConsumed: false,
      });
      return cancel(makeToolFailure("cancelled", 1, false));
    }

    const internal = new AbortController();
    const onCallerAbort = (): void => internal.abort();
    signal.addEventListener("abort", onCallerAbort, { once: true });
    const deadline = this.#clock.now() + definition.timeoutMs;
    const maxAttempts = 1 + definition.retry.maxRetries;
    let attempts = 0;
    let output: unknown;
    let terminalFailure: ToolFailure | undefined;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (signal.aborted) {
          terminalFailure = makeToolFailure("cancelled", attempts, false);
          break;
        }
        if (deadline - this.#clock.now() <= 0) {
          terminalFailure = makeToolFailure("timeout", attempts, false);
          break;
        }
        if (attempt === 1 && definition.meter.commitOn !== "external_dispatch") markBudgetConsumed();
        // attempts increments only when an attempt is really about to start.
        attempts = attempt;
        emit({ type: "started" });
        const outcome = await runAttempt({
          definition,
          input,
          context: Object.freeze({ ...scope, markBudgetConsumed }),
          controller: internal,
          remainingMs: deadline - this.#clock.now(),
          attempts,
          clock: this.#clock,
          onProgress: (progress) => emit({ type: "progress", progress: toSafeProgress(progress) }),
        });
        if (outcome.kind === "value") {
          output = outcome.value;
          break;
        }
        if (outcome.kind === "cancelled") {
          terminalFailure = makeToolFailure("cancelled", attempts, false);
          break;
        }
        if (outcome.kind === "timeout") {
          terminalFailure = makeToolFailure("timeout", attempts, false);
          break;
        }
        if (!outcome.failure.retryable || attempts >= maxAttempts) {
          terminalFailure = outcome.failure;
          break;
        }
        const remaining = deadline - this.#clock.now();
        if (remaining <= 0) {
          terminalFailure = makeToolFailure("timeout", attempts, false);
          break;
        }
        // Backoff is capped by the remaining total deadline.
        const delayMs = Math.min(definition.retry.backoffMs, remaining);
        emit({ type: "retry_scheduled", retryDelayMs: delayMs });
        try {
          await this.#clock.wait(delayMs, internal.signal);
        } catch {
          terminalFailure = makeToolFailure("cancelled", attempts, false);
          break;
        }
      }
    } finally {
      signal.removeEventListener("abort", onCallerAbort);
      internal.abort();
    }

    if (terminalFailure === undefined) {
      const outputSnapshot = snapshotJsonValue(output);
      if (!outputSnapshot.ok || !Value.Check(definition.outputSchema, outputSnapshot.value)) {
        terminalFailure = makeToolFailure("invalid_output", attempts, false);
      } else {
        // The frozen snapshot is validated and returned; later mutation of the
        // executor's original value cannot change the result or leak secrets.
        output = outputSnapshot.value;
        try {
          await this.#audit.finish({
            executionId,
            traceId,
            status: "completed",
            attempts,
            budgetConsumed,
            durationMs: this.#clock.now() - startedAt,
          });
        } catch {
          terminalFailure = makeToolFailure("audit_failed", attempts, false);
        }
      }
    }

    if (terminalFailure === undefined) {
      if (budgetConsumed) {
        ledger.complete(token);
      } else {
        ledger.release(token);
      }
      releaseConcurrency();
      releaseGlobal();
      return complete(output, attempts, budgetConsumed);
    }

    ledger.release(token);
    releaseConcurrency();
    releaseGlobal();
    const status: "failed" | "cancelled" =
      terminalFailure.code === "cancelled" ? "cancelled" : "failed";
    await finishAuditBestEffort(this.#audit, {
      executionId,
      traceId,
      status,
      attempts,
      budgetConsumed,
      failure: terminalFailure,
      durationMs: this.#clock.now() - startedAt,
    });
    return status === "cancelled"
      ? cancel(terminalFailure, budgetConsumed)
      : fail(terminalFailure, budgetConsumed);
  }
}
