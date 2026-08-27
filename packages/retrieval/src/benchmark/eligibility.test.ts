import { describe, expect, it } from "vitest";
import {
  BenchmarkInputError,
  scoreBenchmark,
  type BenchmarkedRun,
  type BenchmarkScoringInput,
} from "./scoring.js";
import { QUERIES_V1 } from "./queries.js";
import { REFERENCE_COMPANIES_V1 } from "./reference-companies.js";

type Run = import("./eligibility.js").BenchmarkedRun;

function result(url: string, title = "t", snippet = "s"): import("../search-provider.js").NormalizedSearchResult {
  return { title, url, snippet, rank: 1, provider: "p" };
}

function run(provider: string, queryId: string, query: string, urls: string[], latencyMs = 100, costUsd = 0, round = 0): Run {
  return {
    provider,
    queryId,
    query,
    round,
    results: urls.map((url) => ({ ...result(url), rank: urls.indexOf(url) + 1 })),
    latencyMs,
    costUsd,
  };
}

function input(overrides: Partial<BenchmarkScoringInput> = {}): BenchmarkScoringInput {
  return {
    runs: [],
    runsPerQuery: 2,
    linkValidity: {},
    queries: { version: "v1", queries: QUERIES_V1 },
    reference: { version: "v1", companies: REFERENCE_COMPANIES_V1 },
    ...overrides,
  };
}

function completeRuns(provider: string, urls: (queryId: string) => string[]): Run[] {
  return QUERIES_V1.flatMap((query) =>
    [0, 1].map((round) => run(provider, query.id, query.query, urls(query.id), 10, 0, round)),
  );
}

describe("benchmark completion and eligibility (focused revision)", () => {
  it("requires every query to complete exactly runsPerQuery times (round identity)", () => {
    const allQueries = QUERIES_V1.flatMap((query) => [0, 1].map((round) => run("a", query.id, query.query, ["https://unitree.com/", "https://tesla.com/"], 10, 0, round)));
    const scored = scoreBenchmark(input({ runs: allQueries, linkValidity: { a: { valid: 20, total: 20 } } }));
    expect(scored.completions.find((completion) => completion.provider === "a")!.completed).toBe(true);
    expect(scored.providers).toHaveLength(1);
    expect(scored.providers[0]!.runsCompleted).toBe(20);

    // two providers with one run each are NOT complete
    const partial = scoreBenchmark(input({
      runs: [
        run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0),
        run("b", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0),
      ],
      linkValidity: { a: { valid: 1, total: 1 }, b: { valid: 1, total: 1 } },
    }));
    expect(partial.completions.every((completion) => completion.completed)).toBe(false);
    expect(partial.hardGates.fewerThanTwoCompleted).toBe(true);
    expect(partial.providers).toHaveLength(0); // nothing eligible for scoring
    expect(partial.raw).toHaveLength(2); // partial data stays in raw

    // 20 duplicate q1 runs are not completion
    const duplicates = input({
      runs: Array.from({ length: 20 }, () => run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0)),
      linkValidity: { a: { valid: 20, total: 20 } },
    });
    expect(scoreBenchmark(duplicates).completions[0]!.completed).toBe(false);

    // missing one query
    const missingOne = input({
      runs: QUERIES_V1.slice(0, 9).flatMap((query) => [0, 1].map((round) => run("a", query.id, query.query, ["https://unitree.com/"], 10, 0, round))),
      linkValidity: { a: { valid: 18, total: 18 } },
    });
    const missingResult = scoreBenchmark(missingOne);
    expect(missingResult.completions[0]!.completed).toBe(false);
    expect(missingResult.completions[0]!.missing).toEqual(["q10"]);

    // duplicate rounds
    const dupRounds = input({
      runs: [
        run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0),
        run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0),
      ],
      linkValidity: { a: { valid: 2, total: 2 } },
    });
    expect(scoreBenchmark(dupRounds).completions[0]!.duplicateRounds).toEqual(["q1:0"]);

    // unknown query ids fail closed
    const unknown = input({
      runs: [run("a", "q99", "nope", ["https://unitree.com/"], 10, 0, 0)],
      linkValidity: { a: { valid: 1, total: 1 } },
    });
    expect(() => scoreBenchmark(unknown)).toThrow(BenchmarkInputError);
  });

  it("reports per-provider eligibility without poisoning other providers", () => {
    const allQueries = (provider: string) =>
      QUERIES_V1.flatMap((query) => [0, 1].map((round) => run(provider, query.id, query.query, ["https://unitree.com/", "https://tesla.com/"], 10, 0, round)));
    // provider "a" contains a dangerous URL; b and c are clean
    const runs = [...allQueries("a"), ...allQueries("b"), ...allQueries("c")];
    const dangerousRunIndex = runs.findIndex((entry) => entry.provider === "a");
    runs[dangerousRunIndex] = { ...runs[dangerousRunIndex]!, results: [{ ...runs[dangerousRunIndex]!.results[0]!, url: "javascript:bad" }] };
    const scored = scoreBenchmark(input({
      runs,
      linkValidity: { a: { valid: 20, total: 20 }, b: { valid: 20, total: 20 }, c: { valid: 20, total: 20 } },
    }));
    const eligibilityA = scored.eligibility.find((entry) => entry.provider === "a")!;
    expect(eligibilityA.eligible).toBe(false);
    expect(eligibilityA.reasons).toContain("dangerous url");
    for (const provider of ["b", "c"]) {
      expect(scored.eligibility.find((entry) => entry.provider === provider)!.eligible).toBe(true);
    }
    expect(scored.providers.map((score) => score.provider).sort()).toEqual(["b", "c"]);
    expect(scored.hardGates.fewerThanTwoCompleted).toBe(false);
  });

  it("rejects illegal measurements fail-closed (no clamping, no interpolation)", () => {
    const invalidLatency = input({
      runs: [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], Number.NaN)],
      linkValidity: { a: { valid: 10, total: 10 } },
    });
    expect(() => scoreBenchmark(invalidLatency)).toThrow(/latencyMs/);

    expect(() => scoreBenchmark(input({
      runs: [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], -5)],
      linkValidity: { a: { valid: 1, total: 1 } },
    }))).toThrow(/latencyMs/);

    // negative cost is NEVER silently zeroed (would reward bad data)
    expect(() => scoreBenchmark(input({
      runs: [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, -1)],
      linkValidity: { a: { valid: 1, total: 1 } },
    }))).toThrow(/costUsd/);

    // illegal denominator (valid > total)
    expect(() => scoreBenchmark(input({
      runs: [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10)],
      linkValidity: { a: { valid: 10, total: 5 } },
    }))).toThrow(/link validity/);

    // wrong round identity and unknown query ids
    expect(() => scoreBenchmark(input({
      runs: [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 5)],
      linkValidity: { a: { valid: 1, total: 1 } },
    }))).toThrow(/round/);
    expect(() => scoreBenchmark(input({
      runs: [run("a", "q99", "nope", ["https://unitree.com/"], 10)],
      linkValidity: { a: { valid: 1, total: 1 } },
    }))).toThrow(/unknown query/);
  });

  it("requires EVERY fixed Chinese query to have results (q1 alone is not enough)", () => {
    // q1 has results; q2-q7 are empty for provider "a"
    const runs = completeRuns("a", (queryId) => (queryId === "q1" ? ["https://unitree.com/"] : []));
    const goodB = completeRuns("b", () => ["https://unitree.com/", "https://tesla.com/"]);
    const scored = scoreBenchmark(input({
      runs: [...runs, ...goodB],
      linkValidity: { a: { valid: 40, total: 40 }, b: { valid: 40, total: 40 } },
    }));
    const eligibilityA = scored.eligibility.find((entry) => entry.provider === "a")!;
    expect(eligibilityA.eligible).toBe(false);
    expect(eligibilityA.reasons.some((reason) => /chinese query empty: q[2-7]/.test(reason))).toBe(true);
    expect(eligibilityA.reasons).not.toContain("chinese query empty: q1");
    expect(scored.eligibility.find((entry) => entry.provider === "b")!.eligible).toBe(true);
  });

  it("requires the run query text to match the frozen query set (fail closed)", () => {
    const runs = completeRuns("a", () => ["https://unitree.com/", "https://tesla.com/"]);
    // forge a correct qid with the wrong text -> whole benchmark rejected
    const target = runs.find((entry) => entry.queryId === "q1")!;
    target.query = "篡改的查询文本";
    expect(() => scoreBenchmark(input({
      runs,
      linkValidity: { a: { valid: 40, total: 40 } },
    }))).toThrow(/query text mismatch/);
  });
});
