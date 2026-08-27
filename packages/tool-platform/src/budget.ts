import type { ToolIdentity } from "@deepfield/contracts";
import type { ToolMeterCategory } from "./definition.js";

export class ToolBudgetError extends Error {
  readonly code = "budget_exceeded" as const;

  constructor(message: string) {
    super(message);
    this.name = "ToolBudgetError";
  }
}

export interface ToolBudgetLimits {
  maxCalls?: number;
  maxCallsPerTool?: number;
  categoryCalls?: Partial<Record<ToolMeterCategory, number>>;
  maxBytes?: number;
  deadlineMs?: number;
  maxConcurrency?: number;
  maxConcurrencyPerTool?: number;
}

export interface ToolBudgetToken {
  readonly identity: ToolIdentity;
  readonly category: ToolMeterCategory;
}

const METER_CATEGORIES = new Set(["search", "fetch", "link_check", "parse", "none"] as const);

class BudgetToken implements ToolBudgetToken {
  state: "active" | "completed" | "released" = "active";

  constructor(
    readonly identity: ToolIdentity,
    readonly category: ToolMeterCategory,
  ) {}
}

function assertValidLimits(limits: ToolBudgetLimits): void {
  const check = (name: string, value: number | undefined, integer: boolean): void => {
    if (value === undefined) {
      return;
    }
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isInteger(value))
    ) {
      throw new ToolBudgetError(`invalid budget limit: ${name}`);
    }
  };
  check("maxCalls", limits.maxCalls, true);
  check("maxCallsPerTool", limits.maxCallsPerTool, true);
  check("maxBytes", limits.maxBytes, true);
  check("deadlineMs", limits.deadlineMs, true);
  check("maxConcurrency", limits.maxConcurrency, true);
  check("maxConcurrencyPerTool", limits.maxConcurrencyPerTool, true);
  if (limits.categoryCalls !== undefined) {
    for (const [category, cap] of Object.entries(limits.categoryCalls)) {
      if (!METER_CATEGORIES.has(category as ToolMeterCategory)) {
        throw new ToolBudgetError("invalid budget limit: unknown category");
      }
      check(`categoryCalls.${category}`, cap, true);
    }
  }
}

/**
 * Atomic per-trace budget ledger. `reserve` checks every limit and consumes
 * synchronously before returning the token, so two concurrent reservations can
 * never both take the last remaining slot.
 */
export class ToolBudgetLedger {
  readonly #limits: ToolBudgetLimits;
  readonly #clock: () => number;
  readonly #startedAt: number;
  #calls = 0;
  #perToolCalls = new Map<string, number>();
  #categoryCalls = new Map<string, number>();
  #bytes = 0;
  #concurrency = 0;
  #perToolConcurrency = new Map<string, number>();

  constructor(limits: ToolBudgetLimits, clock: () => number = Date.now) {
    assertValidLimits(limits);
    this.#limits = {
      ...limits,
      ...(limits.categoryCalls !== undefined ? { categoryCalls: { ...limits.categoryCalls } } : {}),
    };
    this.#clock = clock;
    this.#startedAt = clock();
  }

  reserve(identity: ToolIdentity, category: ToolMeterCategory): ToolBudgetToken {
    if (
      typeof identity?.name !== "string" ||
      identity.name.trim().length === 0 ||
      !Number.isInteger(identity.version) ||
      identity.version < 1
    ) {
      throw new ToolBudgetError("invalid tool identity");
    }
    if (!METER_CATEGORIES.has(category)) {
      throw new ToolBudgetError("invalid meter category");
    }
    const name = identity.name;
    if (this.#limits.deadlineMs !== undefined && this.#clock() - this.#startedAt >= this.#limits.deadlineMs) {
      throw new ToolBudgetError("tool budget exceeded: deadline");
    }
    if (this.#limits.maxCalls !== undefined && this.#calls >= this.#limits.maxCalls) {
      throw new ToolBudgetError("tool budget exceeded: max calls");
    }
    if (
      this.#limits.maxCallsPerTool !== undefined &&
      (this.#perToolCalls.get(name) ?? 0) >= this.#limits.maxCallsPerTool
    ) {
      throw new ToolBudgetError("tool budget exceeded: max calls per tool");
    }
    if (this.#limits.categoryCalls !== undefined) {
      const cap = this.#limits.categoryCalls[category];
      if (cap !== undefined && (this.#categoryCalls.get(category) ?? 0) >= cap) {
        throw new ToolBudgetError("tool budget exceeded: category calls");
      }
    }
    if (this.#limits.maxConcurrency !== undefined && this.#concurrency >= this.#limits.maxConcurrency) {
      throw new ToolBudgetError("tool budget exceeded: max concurrency");
    }
    if (
      this.#limits.maxConcurrencyPerTool !== undefined &&
      (this.#perToolConcurrency.get(name) ?? 0) >= this.#limits.maxConcurrencyPerTool
    ) {
      throw new ToolBudgetError("tool budget exceeded: max per-tool concurrency");
    }
    this.#calls += 1;
    this.#perToolCalls.set(name, (this.#perToolCalls.get(name) ?? 0) + 1);
    this.#categoryCalls.set(category, (this.#categoryCalls.get(category) ?? 0) + 1);
    this.#concurrency += 1;
    this.#perToolConcurrency.set(name, (this.#perToolConcurrency.get(name) ?? 0) + 1);
    return new BudgetToken(identity, category);
  }

  recordBytes(bytes: number): void {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
      throw new ToolBudgetError("invalid byte count");
    }
    if (bytes === 0) {
      return;
    }
    const next = this.#bytes + bytes;
    if (this.#limits.maxBytes !== undefined && next > this.#limits.maxBytes) {
      throw new ToolBudgetError("tool budget exceeded: max bytes");
    }
    this.#bytes = next;
  }

  /** Reconciles actual bytes and frees concurrency; idempotent per token. */
  complete(token: ToolBudgetToken, finalBytes?: number): void {
    if (!(token instanceof BudgetToken)) {
      throw new ToolBudgetError("invalid budget token");
    }
    if (token.state === "completed") {
      return;
    }
    if (finalBytes !== undefined) {
      this.recordBytes(finalBytes);
    }
    if (token.state === "released") {
      token.state = "completed";
      return;
    }
    token.state = "completed";
    this.#releaseConcurrency(token);
  }

  /** Frees concurrency only; the reserved attempt stays consumed. Idempotent. */
  release(token: ToolBudgetToken): void {
    if (!(token instanceof BudgetToken)) {
      throw new ToolBudgetError("invalid budget token");
    }
    if (token.state === "released" || token.state === "completed") {
      return;
    }
    token.state = "released";
    this.#releaseConcurrency(token);
  }

  #releaseConcurrency(token: BudgetToken): void {
    this.#concurrency = Math.max(0, this.#concurrency - 1);
    const name = token.identity.name;
    const remaining = (this.#perToolConcurrency.get(name) ?? 1) - 1;
    this.#perToolConcurrency.set(name, Math.max(0, remaining));
  }
}
