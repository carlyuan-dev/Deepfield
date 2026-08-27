import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  ToolBudgetError,
  ToolBudgetLedger,
  ToolPolicy,
  ToolRegistry,
  ToolRunner,
  ToolSet,
} from "@deepfield/tool-platform";
import type {
  RetryClock,
  ToolActor,
  ToolAuditSink,
  ToolBudgetLimits,
  ToolDefinition,
} from "@deepfield/tool-platform";
import type { ToolExecutionEvent, ToolExecutionResult, ToolRunRequest } from "@deepfield/contracts";
import type { ToolRuntime } from "./message-loop.js";
import { createPiAgentTools } from "./pi-tool-adapter.js";

class RealRetryClock implements RetryClock {
  now(): number {
    return Date.now();
  }

  wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (typeof timeout === "object" && "unref" in timeout) {
        timeout.unref();
      }
      const onAbort = (): void => {
        clearTimeout(timeout);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const probeInputSchema = Type.Object(
  { text: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const probeOutputSchema = Type.Object(
  { text: Type.String() },
  { additionalProperties: false },
);

/** Offline probe tool: no network. Only dev/test/opt-in assemblies register it. */
export function echoProbeDefinition(): ToolDefinition<typeof probeInputSchema, typeof probeOutputSchema> {
  return {
    identity: { name: "echo_probe", version: 1 },
    label: "Echo Probe",
    description: "Offline probe tool that echoes its text input (no network).",
    inputSchema: probeInputSchema,
    outputSchema: probeOutputSchema,
    effect: "project.read",
    timeoutMs: 5000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 4,
    meter: { category: "none", countsBytes: false, countsTime: true },
    model: { formatOutput: (output) => `probe: ${output.text}` },
    execute: async ({ text }) => ({ text }),
  };
}

const PROBE_GRANTS: Record<ToolActor, boolean> = {
  main_agent: true,
  developer_probe: true,
  capability: false,
  child_agent: false,
  direct_ui: false,
};

/** Actor-scoped trusted ToolSet: one grant per identity, never mixed actors. */
export function createTrustedToolSet(actor: ToolActor): ToolSet {
  if (!PROBE_GRANTS[actor]) {
    return new ToolSet([]);
  }
  return new ToolSet([
    { identity: { name: "echo_probe", version: 1 }, actor, effect: "project.read" },
  ]);
}

export interface TraceBudgetPoolOptions {
  limits: ToolBudgetLimits;
  maxTraces?: number;
  clock?: () => number;
}

/**
 * Strictly bounded per-trace budget pool with an explicit lifecycle. A trace
 * ledger is only ever removed by releaseTrace() (and only when it has no
 * in-flight tokens); idle-but-unreleased traces are never evicted or reset, so
 * a serial research trace cannot bypass maxCalls by getting LRU-evicted. When
 * at capacity, ledgerFor() refuses new traces (the Runner maps the thrown
 * budget error to a safe budget_exceeded result).
 */
export class TraceBudgetPool {
  readonly #entries = new Map<string, ToolBudgetLedger>();
  readonly #limits: ToolBudgetLimits;
  readonly #maxTraces: number;
  readonly #clock: () => number;

  constructor(options: TraceBudgetPoolOptions) {
    this.#limits = options.limits;
    this.#maxTraces = options.maxTraces ?? 64;
    this.#clock = options.clock ?? Date.now;
  }

  ledgerFor(traceId: string): ToolBudgetLedger {
    const existing = this.#entries.get(traceId);
    if (existing !== undefined) {
      return existing;
    }
    if (this.#entries.size >= this.#maxTraces) {
      throw new ToolBudgetError("tool budget exceeded: max traces");
    }
    const ledger = new ToolBudgetLedger(this.#limits, this.#clock);
    this.#entries.set(traceId, ledger);
    return ledger;
  }

  /**
   * Explicit end-of-trace: removes the ledger only when no token is in flight.
   * Returns false (and keeps the ledger) while the trace is active so a budget
   * is never silently reset under an in-flight execution.
   */
  releaseTrace(traceId: string): boolean {
    const ledger = this.#entries.get(traceId);
    if (ledger === undefined) {
      return true;
    }
    if (ledger.activeCount() > 0) {
      return false;
    }
    this.#entries.delete(traceId);
    return true;
  }

  size(): number {
    return this.#entries.size;
  }

  has(traceId: string): boolean {
    return this.#entries.has(traceId);
  }
}

export const TRACE_BUDGET_LIMITS: ToolBudgetLimits = {
  maxCalls: 12,
  categoryCalls: { search: 1, link_check: 3, fetch: 3 },
};

export interface ToolRuntimeOptions {
  audit: ToolAuditSink;
  registerProbe?: boolean;
  maxTraces?: number;
}

export interface PiToolContext {
  traceId: string;
  actor: ToolActor;
  projectId?: string;
}

export interface UtilityToolRuntime extends ToolRuntime {
  registry: ToolRegistry;
  policy: ToolPolicy;
  runner: ToolRunner;
  audit: ToolAuditSink;
  run(
    request: ToolRunRequest,
    emit: (event: ToolExecutionEvent) => void,
    signal: AbortSignal,
  ): Promise<ToolExecutionResult>;
  createAgentTools(context: PiToolContext): ReturnType<typeof createPiAgentTools>;
  traceLedgerCount(): number;
  tracePool: TraceBudgetPool;
  /** Explicit end-of-trace; false while the trace has in-flight tokens. */
  releaseTrace(traceId: string): boolean;
}

export function createToolRuntime(options: ToolRuntimeOptions): UtilityToolRuntime {
  const registry = new ToolRegistry();
  if (options.registerProbe === true) {
    registry.register(echoProbeDefinition());
  }
  registry.freeze();
  const policy = new ToolPolicy();
  const clock = new RealRetryClock();
  const tracePool = new TraceBudgetPool({
    limits: TRACE_BUDGET_LIMITS,
    ...(options.maxTraces !== undefined ? { maxTraces: options.maxTraces } : {}),
    clock: () => clock.now(),
  });
  const runner = new ToolRunner({
    registry,
    policy,
    budget: new ToolBudgetLedger({}, () => clock.now()),
    audit: options.audit,
    clock,
    budgetForTrace: (traceId) => tracePool.ledgerFor(traceId),
    globalConcurrency: 4,
    networkToolConcurrency: 2,
  });
  const toolSetByActor = new Map<ToolActor, ToolSet>();
  for (const actor of ["main_agent", "capability", "child_agent", "direct_ui", "developer_probe"] as const) {
    toolSetByActor.set(actor, createTrustedToolSet(actor));
  }
  return {
    registry,
    policy,
    runner,
    audit: options.audit,
    tracePool,
    traceLedgerCount: () => tracePool.size(),
    releaseTrace: (traceId) => tracePool.releaseTrace(traceId),
    async run(request, emit, signal): Promise<ToolExecutionResult> {
      return runner.execute(
        {
          executionId: request.executionId,
          traceId: request.traceId,
          tool: request.tool,
          input: request.input,
        },
        {
          traceId: request.traceId,
          actor: request.actor,
          ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
          toolSet: toolSetByActor.get(request.actor) ?? createTrustedToolSet(request.actor),
        },
        signal,
        emit,
      );
    },
    createAgentTools(context) {
      return createPiAgentTools(registry, runner, {
        traceId: context.traceId,
        actor: context.actor,
        ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
        toolSet: toolSetByActor.get(context.actor) ?? createTrustedToolSet(context.actor),
      });
    },
  };
}
