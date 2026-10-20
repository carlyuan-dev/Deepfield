import { ToolBudgetError, ToolBudgetLedger, type ToolBudgetLimits } from "./budget.js";

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
  readonly #traceLimits = new Map<string, ToolBudgetLimits>();
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
    const ledger = new ToolBudgetLedger(this.#traceLimits.get(traceId) ?? this.#limits, this.#clock);
    this.#entries.set(traceId, ledger);
    return ledger;
  }

  initializeTrace(traceId: string, limits: ToolBudgetLimits): void {
    if (this.#entries.has(traceId)) throw new ToolBudgetError("trace budget already initialized");
    this.#traceLimits.set(traceId, limits);
  }

  /**
   * Explicit end-of-trace: removes the ledger only when no token is in flight.
   * Returns false (and keeps the ledger) while the trace is active so a budget
   * is never silently reset under an in-flight execution.
   */
  releaseTrace(traceId: string): boolean {
    const ledger = this.#entries.get(traceId);
    if (ledger === undefined) {
      this.#traceLimits.delete(traceId);
      return true;
    }
    if (ledger.activeCount() > 0) {
      return false;
    }
    this.#entries.delete(traceId);
    this.#traceLimits.delete(traceId);
    return true;
  }

  size(): number {
    return this.#entries.size;
  }

  has(traceId: string): boolean {
    return this.#entries.has(traceId);
  }
}
