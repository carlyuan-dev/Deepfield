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

type TokenState = "active" | "released" | "completed";

interface TokenRecord {
  owner: ToolBudgetLedger;
  state: TokenState;
  /** Immutable per-tool key captured at reserve time. */
  toolName: string;
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
 * Atomic per-trace budget ledger. `reserve` checks every limit and consumes
 * synchronously before returning the token, so two concurrent reservations can
 * never both take the last remaining slot. Tokens are owned by the ledger that
 * created them; lifecycle state is private and unforgeable.
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
    // Defensive copy frozen at reserve time: later caller mutation of the
    // identity object must not change the keys used for counting or release.
    const capturedIdentity = Object.freeze({ name: identity.name, version: identity.version });
    const name = capturedIdentity.name;
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
    const token = new BudgetToken(capturedIdentity, category);
    tokenRecords.set(token, { owner: this, state: "active", toolName: name });
    return token;
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
    if (record.state === "completed") {
      return;
    }
    const wasActive = record.state === "active";
    try {
      if (finalBytes !== undefined) {
        this.recordBytes(finalBytes);
      }
    } finally {
      record.state = "completed";
      if (wasActive) {
        this.#releaseConcurrency(record);
      }
    }
  }

  /** Frees concurrency only; the reserved attempt stays consumed. Idempotent. */
  release(token: ToolBudgetToken): void {
    const record = this.#requireOwnedRecord(token);
    if (record.state === "released" || record.state === "completed") {
      return;
    }
    record.state = "released";
    this.#releaseConcurrency(record);
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
}
