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
import type { ToolAuditSink } from "./audit.js";
import { finishAuditBestEffort, runAttempt } from "./runner-attempt.js";
import {
  snapshotExecutionInput,
  snapshotJsonValue,
  snapshotToolIdentity,
} from "./snapshot.js";

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
const INVALID_EXECUTION_ID = "invalid-execution";
const INVALID_TRACE_ID = "invalid-trace";

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
      return invalidInputPlaceholder(call);
    }
    const executionId = call.executionId;
    const traceId = call.traceId;
    // Capture everything the pipeline depends on before the first emit: a
    // listener running on `accepted` must not be able to change actor,
    // project, trace, toolSet or confirmations for this execution.
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
      await finishAuditBestEffort(this.#audit, {
        executionId,
        traceId,
        status: "cancelled",
        attempts: 1,
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
        // attempts increments only when an executor attempt is really about to
        // start, so deadline/cancel hits between attempts never inflate it.
        attempts = attempt;
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
        if (!outcome.failure.retryable || attempts >= maxAttempts) {
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
      const outputSnapshot = snapshotJsonValue(output);
      if (!outputSnapshot.ok || !Value.Check(definition.outputSchema, outputSnapshot.value)) {
        terminalFailure = makeToolFailure("invalid_output", attempts, false);
      } else {
        // The frozen snapshot is what gets validated and returned: the
        // executor's original value can be mutated at any time afterwards
        // without changing the result or leaking secrets.
        output = outputSnapshot.value;
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
    await finishAuditBestEffort(this.#audit, {
      executionId,
      traceId,
      status,
      attempts,
      failure: terminalFailure,
      durationMs: this.#clock.now() - startedAt,
    });
    return status === "cancelled" ? cancel(terminalFailure) : fail(terminalFailure);
  }
}

function invalidInputPlaceholder(call: ToolCallRequest): ToolExecutionResult {
  return {
    executionId:
      typeof call.executionId === "string" && call.executionId.length > 0
        ? call.executionId
        : INVALID_EXECUTION_ID,
    traceId:
      typeof call.traceId === "string" && call.traceId.length > 0
        ? call.traceId
        : INVALID_TRACE_ID,
    tool: INVALID_TOOL_PLACEHOLDER,
    status: "failed",
    failure: makeToolFailure("invalid_input", 1, false),
    attempts: 1,
  };
}
