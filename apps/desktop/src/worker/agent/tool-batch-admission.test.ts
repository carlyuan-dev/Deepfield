import { describe, expect, it } from "vitest";
import type { ToolBudgetSnapshot } from "@deepfield/tool-platform";
import {
  planToolBatch,
  type PriorToolResult,
  type ToolBatchCall,
} from "./tool-batch-admission.js";

function snapshot(remaining: { search: number; fetch: number }): ToolBudgetSnapshot {
  const dimension = (value: number) => ({
    limit: value,
    reserved: 0,
    consumed: 0,
    remaining: value,
    exhausted: value === 0,
  });
  return {
    total: dimension(remaining.search + remaining.fetch),
    categories: {
      search: dimension(remaining.search),
      fetch: dimension(remaining.fetch),
      link_check: dimension(0),
      parse: dimension(0),
      none: dimension(0),
    },
  };
}

function search(query: string): ToolBatchCall {
  return { id: `search-${query.trim().toLowerCase()}`, name: "web_search", input: { query } };
}

function fetch(url: string, id = "fetch-a"): ToolBatchCall {
  return { id, name: "read_webpage", input: { url } };
}

const completedSearchResult: PriorToolResult = { status: "completed", result: { citations: ["a"] } };

describe("planToolBatch", () => {
  it("trims independently by category", () => {
    const plan = planToolBatch({
      calls: [search("a"), search("b"), search("c"), fetch("https://a.test")],
      snapshot: snapshot({ search: 2, fetch: 1 }),
      priorResults: new Map(),
      turnIndex: 1,
    });

    expect(plan.admitted.map((call) => call.id)).toEqual(["search-a", "search-b", "fetch-a"]);
    expect(plan.skipped.map((call) => call.id)).toEqual(["search-c"]);
  });

  it("reuses an exact successful query without spending quota", () => {
    const key = planToolBatch({
      calls: [search("  Unitree  ")],
      snapshot: snapshot({ search: 1, fetch: 1 }),
      priorResults: new Map(),
      turnIndex: 1,
    }).admitted[0]!.normalizedKey!;
    const plan = planToolBatch({
      calls: [search("  Unitree  ")],
      snapshot: snapshot({ search: 1, fetch: 1 }),
      priorResults: new Map([[key, completedSearchResult]]),
      turnIndex: 2,
    });

    expect(plan.reused).toHaveLength(1);
    expect(plan.admitted).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
    expect(plan.reused[0]?.priorResult).toEqual(completedSearchResult);
  });

  it("reuses a same-batch normalized URL instead of taking a second fetch slot", () => {
    const plan = planToolBatch({
      calls: [fetch("https://a.test"), fetch("https://a.test/", "fetch-a-repeat")],
      snapshot: snapshot({ search: 1, fetch: 1 }),
      priorResults: new Map(),
      turnIndex: 3,
    });

    expect(plan.admitted.map((call) => call.id)).toEqual(["fetch-a"]);
    expect(plan.reused.map((call) => call.id)).toEqual(["fetch-a-repeat"]);
  });

  it("allows a retryable prior failure to spend a new category slot", () => {
    const key = planToolBatch({
      calls: [search("Unitree")],
      snapshot: snapshot({ search: 1, fetch: 1 }),
      priorResults: new Map(),
      turnIndex: 1,
    }).admitted[0]!.normalizedKey!;
    const plan = planToolBatch({
      calls: [search("Unitree")],
      snapshot: snapshot({ search: 1, fetch: 1 }),
      priorResults: new Map([[key, { status: "failed", retryable: true }]]),
      turnIndex: 4,
    });

    expect(plan.admitted).toHaveLength(1);
  });

  it("does not reuse an invalid date-range failure for corrected search arguments", () => {
    const reversed = {
      id: "reversed",
      name: "web_search",
      input: {
        query: "Unitree",
        maxResults: 3,
        timeRange: { from: "2026-09-14", to: "2026-06-14" },
      },
    } satisfies ToolBatchCall;
    const first = planToolBatch({
      calls: [reversed],
      snapshot: snapshot({ search: 1, fetch: 1 }),
      priorResults: new Map(),
      turnIndex: 5,
    });
    const failed = { status: "failed", retryable: false } satisfies PriorToolResult;
    const corrected = {
      ...reversed,
      id: "corrected",
      input: {
        ...reversed.input,
        timeRange: { from: "2026-06-14", to: "2026-09-14" },
      },
    } satisfies ToolBatchCall;

    const second = planToolBatch({
      calls: [corrected],
      snapshot: snapshot({ search: 1, fetch: 1 }),
      priorResults: new Map([[first.admitted[0]!.failureKey!, failed]]),
      turnIndex: 6,
    });

    expect(second.admitted.map((call) => call.id)).toEqual(["corrected"]);
    expect(second.reused).toHaveLength(0);
  });

  it("binds a same-batch duplicate only to the current admitted source", () => {
    const failed = { status: "failed", retryable: true } satisfies PriorToolResult;
    const key = planToolBatch({
      calls: [search("Unitree")],
      snapshot: snapshot({ search: 1, fetch: 1 }),
      priorResults: new Map(),
      turnIndex: 1,
    }).admitted[0]!.failureKey!;
    const plan = planToolBatch({
      calls: [
        { id: "retry", name: "web_search", input: { query: "Unitree" } },
        { id: "duplicate", name: "web_search", input: { query: " unitree " } },
      ],
      snapshot: snapshot({ search: 1, fetch: 1 }),
      priorResults: new Map([[key, failed]]),
      turnIndex: 7,
    });

    expect(plan.admitted.map((call) => call.id)).toEqual(["retry"]);
    expect(plan.reused).toEqual([
      expect.objectContaining({ id: "duplicate", reusedFromId: "retry" }),
    ]);
    expect(plan.reused[0]?.priorResult).toBeUndefined();
  });

  it("does not reuse a same-batch call that was trimmed before dispatch", () => {
    const plan = planToolBatch({
      calls: [search("Unitree"), search(" unitree ")],
      snapshot: snapshot({ search: 0, fetch: 1 }),
      priorResults: new Map(),
      turnIndex: 8,
    });

    expect(plan.admitted).toHaveLength(0);
    expect(plan.reused).toHaveLength(0);
    expect(plan.skipped.map((call) => call.id)).toEqual(["search-unitree", "search-unitree"]);
  });
});
