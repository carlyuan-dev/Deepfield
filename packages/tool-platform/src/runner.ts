import { Value } from "typebox/value";
import type { ToolCallRequest, ToolExecutionResult, ToolIdentity } from "@deepfield/contracts";
import type { ToolBudgetLedger, ToolBudgetToken } from "./budget.js";
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
import type { ToolAuditFinish, ToolAuditSink } from "./audit.js";
import { runAttempt } from "./runner-attempt.js";
import { snapshotInput, snapshotScope, snapshotToolIdentity } from "./snapshot.js";

export interface ToolRunnerOptions {
  registry: ToolRegistry;
  policy: ToolPolicy;
  budget: ToolBudgetLedger;
  audit: ToolAuditSink;
  clock: RetryClock;
}

// Only reachable for out-of-contract calls whose tool identity cannot be
// snapshotted at all; the result is a safe invalid_input with a frozen
// placeholder so no mutable caller object is ever exposed.
const INVALID_TOOL_PLACEHOLDER: ToolIdentity = Object.freeze({ name: "invalid_tool", version: 1 });

/**
 * Single execution pipeline shared by Pi adapters, Capabilities and direct
 * callers: entry snapshot -> resolve -> validate input -> policy -> budget ->
 * audit start -> started -> execute/retry -> validate output -> required audit
 * finish + budget finalize -> exactly one terminal event. The caller's call
 * and context are snapshotted before the first emit/await, so listeners,
 * policy, audit and later caller mutation cannot change what the pipeline
 * sees.
 */
export class ToolRunner {
  readonly #registry: ToolRegistry;
  readonly #policy: ToolPolicy;
  readonly #budget: ToolBudgetLedger;
  readonly #audit: ToolAuditSink;
  readonly #clock: RetryClock;

  constructor(options: ToolRunnerOptions) {
    this.#registry = options.registry;
    this.#policy = options.policy;
    this.#budget = options.budget;
    this.#audit = options.audit;
    this.#clock = options.clock;
  }

  async execute(
    call: ToolCallRequest,
    context: ToolRunContext,
    signal: AbortSignal,
    onEvent: ToolEventSink,
  ): Promise<ToolExecutionResult> {
    const tool = snapshotToolIdentity(call.tool);
    if (tool === undefined) {
      return this.#invalidInputPlaceholder(call);
    }
    const executionId = call.executionId;
    const traceId = call.traceId;
    let input: unknown;
    try {
      input = snapshotInput(call.input);
    } catch {
      input = undefined;
    }
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
    // Single-line result builders keep this hot-path file under the hard
    // 300-line production limit; the pipeline reads top to bottom.
    const fail = (failure: ToolFailure): ToolExecutionResult => {
      emit({ type: "failed", failure });
      return settle({ executionId, traceId, tool, status: "failed", failure, attempts: failure.attempts, durationMs: this.#clock.now() - startedAt });
    };
    const cancel = (failure: ToolFailure): ToolExecutionResult => {
      emit({ type: "cancelled", failure });
      return settle({ executionId, traceId, tool, status: "cancelled", failure, attempts: failure.attempts, durationMs: this.#clock.now() - startedAt });
    };
    const complete = (output: unknown, attempts: number): ToolExecutionResult => {
      emit({ type: "completed" });
      return settle({ executionId, traceId, tool, status: "completed", output: output as never, attempts, durationMs: this.#clock.now() - startedAt });
    };

    emit({ type: "accepted" });
    if (input === undefined) {
      return fail(makeToolFailure("invalid_input", 1, false));
    }
    const scope = snapshotScope({
      traceId: context.traceId,
      actor: context.actor,
      projectId: context.projectId,
    });
    if (scope === undefined || scope.traceId !== traceId) {
      return fail(makeToolFailure("invalid_input", 1, false));
    }

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
      context,
    );
    if (decision.decision === "deny") {
      return fail(makeToolFailure(decision.code, 1, false));
    }
    if (decision.decision === "confirmation_required") {
      return fail(makeToolFailure("confirmation_required", 1, false));
    }
    emit({ type: "policy_checked" });

    let token: ToolBudgetToken;
    try {
      token = this.#budget.reserve(tool, definition.meter.category);
    } catch {
      return fail(makeToolFailure("budget_exceeded", 1, false));
    }
    try {
      await this.#audit.start({
        executionId,
        traceId,
        ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
        actor: scope.actor,
        tool,
        attempts: 0,
      });
    } catch {
      this.#budget.release(token);
      return fail(makeToolFailure("audit_failed", 1, false));
    }

    if (signal.aborted) {
      this.#budget.release(token);
      await this.#finishAuditBestEffort({ executionId, traceId, status: "cancelled", attempts: 1 });
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
        attempts = attempt;
        if (signal.aborted) {
          terminalFailure = makeToolFailure("cancelled", attempts, false);
          break;
        }
        if (deadline - this.#clock.now() <= 0) {
          terminalFailure = makeToolFailure("timeout", attempts, false);
          break;
        }
        emit({ type: "started" });
        const outcome = await runAttempt({
          definition,
          input,
          context: scope,
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
        if (!outcome.failure.retryable || attempt >= maxAttempts) {
          terminalFailure = outcome.failure;
          break;
        }
        const remaining = deadline - this.#clock.now();
        if (remaining <= 0) {
          terminalFailure = makeToolFailure("timeout", attempts, false);
          break;
        }
        // Backoff is capped by the remaining total deadline: the deadline
        // always bounds executor time plus every backoff, never beyond.
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
      if (!Value.Check(definition.outputSchema, output)) {
        terminalFailure = makeToolFailure("invalid_output", attempts, false);
      } else {
        try {
          await this.#audit.finish({
            executionId,
            traceId,
            status: "completed",
            attempts,
            durationMs: this.#clock.now() - startedAt,
          });
        } catch {
          terminalFailure = makeToolFailure("audit_failed", attempts, false);
        }
      }
    }

    if (terminalFailure === undefined) {
      this.#budget.complete(token);
      return complete(output, attempts);
    }

    this.#budget.release(token);
    const status: "failed" | "cancelled" =
      terminalFailure.code === "cancelled" ? "cancelled" : "failed";
    await this.#finishAuditBestEffort({
      executionId,
      traceId,
      status,
      attempts,
      failure: terminalFailure,
      durationMs: this.#clock.now() - startedAt,
    });
    return status === "cancelled" ? cancel(terminalFailure) : fail(terminalFailure);
  }

  #invalidInputPlaceholder(call: ToolCallRequest): ToolExecutionResult {
    return {
      executionId: typeof call.executionId === "string" ? call.executionId : "",
      traceId: typeof call.traceId === "string" ? call.traceId : "",
      tool: INVALID_TOOL_PLACEHOLDER,
      status: "failed",
      failure: makeToolFailure("invalid_input", 1, false),
      attempts: 1,
    };
  }

  async #finishAuditBestEffort(record: ToolAuditFinish): Promise<void> {
    try {
      await this.#audit.finish(record);
    } catch {
      // Already failing path: audit is best-effort here, never a success claim.
    }
  }
}
