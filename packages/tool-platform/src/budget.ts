import type { ToolIdentity } from "@deepfield/contracts";
import type {
  BudgetDimensionSnapshot,
  ToolBudgetSnapshot,
  ToolMeterCategory,
} from "./budget-contract.js";

export type {
  BudgetDimensionSnapshot,
  ToolBudgetSnapshot,
  ToolMeterCategory,
} from "./budget-contract.js";

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

const METER_CATEGORY_VALUES = ["search", "fetch", "link_check", "parse", "none"] as const;
const METER_CATEGORIES = new Set(METER_CATEGORY_VALUES);

type TokenState = "reserved" | "committed" | "released" | "completed";

interface TokenRecord {
  owner: ToolBudgetLedger;
  state: TokenState;
  /** Immutable per-tool key captured at reserve time. */
  toolName: string;
  category: ToolMeterCategory;
}

// Token lifecycle state lives here, keyed by the exact token object. It cannot
// be forged, moved across ledgers, or modified by callers.
const tokenRecords = new WeakMap<object, TokenRecord>();

class BudgetToken implements ToolBudgetToken {
  constructor(
    readonly identity: ToolIdentity,
    readonly category: ToolMeterCategory,
  ) {
    // Freeze before the token is handed out (and before it is registered in
    // tokenRecords): TypeScript readonly is compile-time only, so the token
    // object itself must be runtime-immutable too.
    Object.freeze(this);
  }
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
 * Atomic per-trace budget ledger. `reserve` checks every limit and holds quota
 * synchronously before returning the token, so two concurrent reservations can
 * never both take the last remaining slot. `commit` converts that hold into a
 * consumed call at dispatch. Tokens are owned by the ledger that created them;
 * lifecycle state is private and unforgeable.
 */
export class ToolBudgetLedger {
  readonly #limits: ToolBudgetLimits;
  readonly #clock: () => number;
  readonly #startedAt: number;
  #reservedCalls = 0;
  #consumedCalls = 0;
  #perToolReserved = new Map<string, number>();
  #perToolConsumed = new Map<string, number>();
  #categoryReserved = new Map<ToolMeterCategory, number>();
  #categoryConsumed = new Map<ToolMeterCategory, number>();
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
    // Defensive copy frozen at reserve time: later caller mutation of the
    // identity object must not change the keys used for counting or release.
    const capturedIdentity = Object.freeze({ name: identity.name, version: identity.version });
    const name = capturedIdentity.name;
    if (this.#limits.deadlineMs !== undefined && this.#clock() - this.#startedAt >= this.#limits.deadlineMs) {
      throw new ToolBudgetError("tool budget exceeded: deadline");
    }
    if (
      this.#limits.maxCalls !== undefined &&
      this.#reservedCalls + this.#consumedCalls >= this.#limits.maxCalls
    ) {
      throw new ToolBudgetError("tool budget exceeded: max calls");
    }
    if (
      this.#limits.maxCallsPerTool !== undefined &&
      (this.#perToolReserved.get(name) ?? 0) + (this.#perToolConsumed.get(name) ?? 0) >=
        this.#limits.maxCallsPerTool
    ) {
      throw new ToolBudgetError("tool budget exceeded: max calls per tool");
    }
    if (this.#limits.categoryCalls !== undefined) {
      const cap = this.#limits.categoryCalls[category];
      if (
        cap !== undefined &&
        (this.#categoryReserved.get(category) ?? 0) +
          (this.#categoryConsumed.get(category) ?? 0) >=
          cap
      ) {
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
    this.#reservedCalls += 1;
    this.#increment(this.#perToolReserved, name);
    this.#increment(this.#categoryReserved, category);
    this.#concurrency += 1;
    this.#perToolConcurrency.set(name, (this.#perToolConcurrency.get(name) ?? 0) + 1);
    const token = new BudgetToken(capturedIdentity, category);
    tokenRecords.set(token, { owner: this, state: "reserved", toolName: name, category });
    return token;
  }

  commit(token: ToolBudgetToken): void {
    const record = this.#requireOwnedRecord(token);
    if (record.state !== "reserved") {
      throw new ToolBudgetError("invalid budget token state");
    }
    record.state = "committed";
    this.#moveReservedToConsumed(record);
  }

  snapshot(): ToolBudgetSnapshot {
    const categories = Object.fromEntries(
      METER_CATEGORY_VALUES.map((category) => [
        category,
        this.#snapshotDimension(
          this.#limits.categoryCalls?.[category],
          this.#categoryReserved.get(category) ?? 0,
          this.#categoryConsumed.get(category) ?? 0,
        ),
      ]),
    ) as Record<ToolMeterCategory, BudgetDimensionSnapshot>;
    Object.freeze(categories);
    return Object.freeze({
      total: this.#snapshotDimension(
        this.#limits.maxCalls,
        this.#reservedCalls,
        this.#consumedCalls,
      ),
      categories,
    });
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

  /**
   * Reconciles actual bytes and frees concurrency. If byte recording fails the
   * concurrency slot is still released exactly once, the consumed attempt is
   * kept, over-limit bytes are not recorded, and the token still becomes
   * terminal so it cannot re-record. Idempotent per token.
   */
  complete(token: ToolBudgetToken, finalBytes?: number): void {
    const record = this.#requireOwnedRecord(token);
    if (record.state === "completed" || record.state === "released") {
      return;
    }
    if (record.state === "reserved") {
      // Preserve existing direct reserve -> complete callers while the runner
      // commits explicitly at the true executor-dispatch boundary.
      record.state = "committed";
      this.#moveReservedToConsumed(record);
    }
    try {
      if (finalBytes !== undefined) {
        this.recordBytes(finalBytes);
      }
    } finally {
      record.state = "completed";
      this.#releaseConcurrency(record);
    }
  }

  /** Releases concurrency and returns quota only when dispatch never began. */
  release(token: ToolBudgetToken): void {
    const record = this.#requireOwnedRecord(token);
    if (record.state === "released" || record.state === "completed") {
      return;
    }
    if (record.state === "reserved") {
      this.#releaseReservation(record);
    }
    record.state = "released";
    this.#releaseConcurrency(record);
  }

  /**
   * Number of currently reserved (in-flight) tokens. Used by trace budget
   * pools to pin active traces during eviction.
   */
  activeCount(): number {
    return this.#concurrency;
  }

  #requireOwnedRecord(token: ToolBudgetToken): TokenRecord {
    const record = tokenRecords.get(token);
    if (record === undefined || record.owner !== this) {
      throw new ToolBudgetError("invalid budget token for this ledger");
    }
    return record;
  }

  #releaseConcurrency(record: TokenRecord): void {
    this.#concurrency = Math.max(0, this.#concurrency - 1);
    const remaining = (this.#perToolConcurrency.get(record.toolName) ?? 1) - 1;
    this.#perToolConcurrency.set(record.toolName, Math.max(0, remaining));
  }

  #moveReservedToConsumed(record: TokenRecord): void {
    this.#reservedCalls = Math.max(0, this.#reservedCalls - 1);
    this.#consumedCalls += 1;
    this.#decrement(this.#perToolReserved, record.toolName);
    this.#increment(this.#perToolConsumed, record.toolName);
    this.#decrement(this.#categoryReserved, record.category);
    this.#increment(this.#categoryConsumed, record.category);
  }

  #releaseReservation(record: TokenRecord): void {
    this.#reservedCalls = Math.max(0, this.#reservedCalls - 1);
    this.#decrement(this.#perToolReserved, record.toolName);
    this.#decrement(this.#categoryReserved, record.category);
  }

  #snapshotDimension(
    limit: number | undefined,
    reserved: number,
    consumed: number,
  ): BudgetDimensionSnapshot {
    if (limit === undefined) {
      return Object.freeze({ reserved, consumed, exhausted: false });
    }
    const remaining = Math.max(0, limit - reserved - consumed);
    return Object.freeze({
      limit,
      reserved,
      consumed,
      remaining,
      exhausted: remaining === 0,
    });
  }

  #increment<K>(counts: Map<K, number>, key: K): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  #decrement<K>(counts: Map<K, number>, key: K): void {
    counts.set(key, Math.max(0, (counts.get(key) ?? 1) - 1));
  }
}
