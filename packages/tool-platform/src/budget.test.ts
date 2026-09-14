import { describe, expect, it } from "vitest";
import { ToolBudgetError, ToolBudgetLedger, type ToolBudgetLimits, type ToolBudgetToken } from "./budget.js";
import type { ToolIdentity } from "@deepfield/contracts";

const searchV1: ToolIdentity = { name: "web_search", version: 1 };
const fetchV1: ToolIdentity = { name: "fetch_url", version: 1 };
const checkV1: ToolIdentity = { name: "check_link_accessibility", version: 1 };

function makeLedger(limits: ToolBudgetLimits, start = 0) {
  let now = start;
  return {
    ledger: new ToolBudgetLedger(limits, () => now),
    advance(ms: number): void {
      now += ms;
    },
  };
}

function expectBudgetExceeded(fn: () => unknown): void {
  expect(fn).toThrow(ToolBudgetError);
}

describe("ToolBudgetLedger", () => {
  it("holds quota at reserve time but consumes only after commit", () => {
    const ledger = new ToolBudgetLedger({ categoryCalls: { search: 1 } });
    const token = ledger.reserve({ name: "web_search", version: 1 }, "search");
    expect(ledger.snapshot().categories.search).toEqual({
      limit: 1, reserved: 1, consumed: 0, remaining: 0, exhausted: true,
    });
    ledger.release(token);
    expect(ledger.snapshot().categories.search.remaining).toBe(1);
  });

  it("keeps an externally attempted failure consumed", () => {
    const ledger = new ToolBudgetLedger({ categoryCalls: { search: 1 } });
    const token = ledger.reserve({ name: "web_search", version: 1 }, "search");
    ledger.commit(token);
    ledger.release(token);
    expect(ledger.snapshot().categories.search.consumed).toBe(1);
  });

  it("returns deeply frozen snapshot copies", () => {
    const ledger = new ToolBudgetLedger({ maxCalls: 2, categoryCalls: { search: 1 } });
    ledger.reserve(searchV1, "search");
    const snapshot = ledger.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.total)).toBe(true);
    expect(Object.isFrozen(snapshot.categories)).toBe(true);
    expect(Object.isFrozen(snapshot.categories.search)).toBe(true);
    expect(() => {
      (snapshot.categories.search as { consumed: number }).consumed = 99;
    }).toThrow(TypeError);
    expect(ledger.snapshot().categories.search.consumed).toBe(0);
  });

  it("enforces the total call limit", () => {
    const { ledger } = makeLedger({ maxCalls: 2 });
    ledger.reserve(searchV1, "search");
    ledger.reserve(fetchV1, "fetch");
    expectBudgetExceeded(() => ledger.reserve(checkV1, "link_check"));
  });

  it("enforces the per-tool call limit by name", () => {
    const { ledger } = makeLedger({ maxCallsPerTool: 1 });
    ledger.reserve(fetchV1, "fetch");
    expectBudgetExceeded(() => ledger.reserve(fetchV1, "fetch"));
    ledger.reserve(searchV1, "search");
  });

  it("enforces category call limits for search, fetch and link checks", () => {
    const { ledger } = makeLedger({ categoryCalls: { search: 1, fetch: 2, link_check: 1 } });
    ledger.reserve(searchV1, "search");
    expectBudgetExceeded(() => ledger.reserve(fetchV1, "search"));
    ledger.reserve(fetchV1, "fetch");
    ledger.reserve(checkV1, "fetch");
    expectBudgetExceeded(() => ledger.reserve(fetchV1, "fetch"));
    ledger.reserve(checkV1, "link_check");
    expectBudgetExceeded(() => ledger.reserve(fetchV1, "link_check"));
  });

  it("enforces the byte budget through recordBytes", () => {
    const { ledger } = makeLedger({ maxBytes: 100 });
    ledger.recordBytes(60);
    ledger.recordBytes(40);
    expectBudgetExceeded(() => ledger.recordBytes(1));
  });

  it("reconciles actual bytes through complete", () => {
    const { ledger } = makeLedger({ maxBytes: 100 });
    const token = ledger.reserve(fetchV1, "fetch");
    ledger.complete(token, 100);
    expectBudgetExceeded(() => ledger.recordBytes(1));
  });

  it("enforces the elapsed deadline with an injected clock", () => {
    const { ledger, advance } = makeLedger({ deadlineMs: 1000 });
    ledger.reserve(searchV1, "search");
    advance(1000);
    expectBudgetExceeded(() => ledger.reserve(fetchV1, "fetch"));
  });

  it("enforces global concurrency", () => {
    const { ledger } = makeLedger({ maxConcurrency: 1 });
    const first = ledger.reserve(fetchV1, "fetch");
    expectBudgetExceeded(() => ledger.reserve(searchV1, "search"));
    ledger.complete(first);
    ledger.reserve(searchV1, "search");
  });

  it("enforces per-tool concurrency", () => {
    const { ledger } = makeLedger({ maxConcurrencyPerTool: 1 });
    const first = ledger.reserve(fetchV1, "fetch");
    expectBudgetExceeded(() => ledger.reserve(fetchV1, "fetch"));
    ledger.reserve(searchV1, "search");
    ledger.release(first);
    ledger.reserve(fetchV1, "fetch");
  });

  it("atomically grants only one reservation against the last remaining call", async () => {
    const { ledger } = makeLedger({ maxCalls: 1 });
    // reserve() is synchronous by design (Step 5), so concurrent attempts are
    // deferred to microtasks; exactly one may take the last remaining slot.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => ledger.reserve(searchV1, "search")),
      Promise.resolve().then(() => ledger.reserve(fetchV1, "fetch")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("keeps tokens single-use: repeat complete cannot corrupt counts", () => {
    const { ledger } = makeLedger({ maxBytes: 100, maxConcurrency: 1 });
    const token = ledger.reserve(fetchV1, "fetch");
    ledger.complete(token, 50);
    ledger.complete(token, 50);
    ledger.recordBytes(49);
    expectBudgetExceeded(() => ledger.recordBytes(2));
    ledger.reserve(searchV1, "search");
  });

  it("release after complete and double release are no-ops that cannot corrupt counts", () => {
    const { ledger } = makeLedger({ maxConcurrency: 1 });
    const token = ledger.reserve(fetchV1, "fetch");
    ledger.complete(token);
    ledger.release(token);
    ledger.reserve(searchV1, "search");
  });

  it("release frees concurrency and returns an uncommitted attempt", () => {
    const { ledger } = makeLedger({ maxCalls: 1, maxConcurrency: 1 });
    const token = ledger.reserve(fetchV1, "fetch");
    ledger.release(token);
    expect(() => ledger.reserve(searchV1, "search")).not.toThrow();
  });

  it("defensively copies limits so callers cannot expand their own budget", () => {
    const limits: ToolBudgetLimits = { maxCalls: 1 };
    const { ledger } = makeLedger(limits);
    limits.maxCalls = 999;
    ledger.reserve(searchV1, "search");
    expectBudgetExceeded(() => ledger.reserve(fetchV1, "fetch"));
  });

  it("rejects invalid tool identities safely", () => {
    const { ledger } = makeLedger({});
    expectBudgetExceeded(() => ledger.reserve({ name: "", version: 1 }, "search"));
    expectBudgetExceeded(() => ledger.reserve({ name: "x", version: 0 }, "search"));
  });

  it("fails with stable safe errors that do not leak inputs", () => {
    const { ledger } = makeLedger({ maxCalls: 1 });
    ledger.reserve(searchV1, "search");
    let message = "";
    try {
      ledger.reserve(fetchV1, "fetch");
    } catch (error) {
      message = (error as ToolBudgetError).message;
    }
    expect(message).toContain("budget");
    expect(message).not.toContain("web_search");
    expect(message).not.toContain("fetch_url");
    expect(message).not.toContain("secret");
  });
});

describe("ToolBudgetLedger token boundaries (focused revision)", () => {
  it("rejects completing or releasing a token on a different ledger", () => {
    const { ledger: ledgerA } = makeLedger({ maxConcurrencyPerTool: 1 });
    const { ledger: ledgerB } = makeLedger({});
    const token = ledgerA.reserve(fetchV1, "fetch");
    expect(() => ledgerB.release(token)).toThrow(ToolBudgetError);
    expect(() => ledgerB.complete(token)).toThrow(ToolBudgetError);
    expect(() => ledgerA.reserve(fetchV1, "fetch")).toThrow(ToolBudgetError);
    ledgerA.release(token);
    ledgerA.reserve(fetchV1, "fetch");
  });

  it("rejects forged tokens that belong to no ledger", () => {
    const { ledger } = makeLedger({});
    const forged = { identity: fetchV1, category: "search" } as unknown as ToolBudgetToken;
    expect(() => ledger.complete(forged)).toThrow(ToolBudgetError);
    expect(() => ledger.release(forged)).toThrow(ToolBudgetError);
  });

  it("captures an immutable identity at reserve time", () => {
    const { ledger } = makeLedger({ maxConcurrencyPerTool: 1 });
    const identity: ToolIdentity = { name: "fetch_url", version: 1 };
    const token = ledger.reserve(identity, "fetch");
    identity.name = "mutated";
    expect(() => ledger.reserve({ name: "fetch_url", version: 1 }, "fetch")).toThrow(
      ToolBudgetError,
    );
    expect(() => ledger.reserve({ name: "mutated", version: 1 }, "fetch")).not.toThrow(
      ToolBudgetError,
    );
    ledger.release(token);
    expect(() => ledger.reserve({ name: "fetch_url", version: 1 }, "fetch")).not.toThrow(
      ToolBudgetError,
    );
    expect(Object.isFrozen(token.identity)).toBe(true);
    expect(() => {
      token.identity.name = "hacked";
    }).toThrow(TypeError);
  });

  it("releases concurrency exactly once when complete fails on over-limit bytes", () => {
    const { ledger } = makeLedger({ maxBytes: 100, maxConcurrency: 1, maxConcurrencyPerTool: 1 });
    const token = ledger.reserve(fetchV1, "fetch");
    expect(() => ledger.complete(token, 200)).toThrow(ToolBudgetError);
    ledger.reserve(fetchV1, "fetch");
    ledger.recordBytes(100);
    ledger.complete(token, 50);
    expect(() => ledger.recordBytes(1)).toThrow(ToolBudgetError);
    ledger.release(token);
  });

  it("fails with safe errors that never leak identity or input", () => {
    const { ledger: ledgerA } = makeLedger({ maxConcurrency: 1 });
    const { ledger: ledgerB } = makeLedger({});
    const token = ledgerA.reserve(fetchV1, "fetch");
    let message = "";
    try {
      ledgerB.release(token);
    } catch (error) {
      message = (error as ToolBudgetError).message;
    }
    expect(message).toContain("token");
    expect(message).not.toContain("fetch_url");
    expect(message).not.toContain("secret");
  });

  it("freezes the token object itself and its captured identity (final revision)", () => {
    const { ledger } = makeLedger({});
    const token = ledger.reserve(fetchV1, "fetch");
    expect(Object.isFrozen(token)).toBe(true);
    expect(Object.isFrozen(token.identity)).toBe(true);
    expect(() => {
      (token as unknown as { identity: ToolIdentity }).identity = { name: "forged", version: 9 };
    }).toThrow(TypeError);
    expect(() => {
      (token as unknown as { category: string }).category = "search";
    }).toThrow(TypeError);
    expect(() => {
      token.identity.name = "hacked";
    }).toThrow(TypeError);
  });
});
