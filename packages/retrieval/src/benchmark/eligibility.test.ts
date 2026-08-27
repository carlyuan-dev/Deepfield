import { describe, expect, it } from "vitest";
import {
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

function completeRuns(provider: string, urls: () => string[]): Run[] {
  return QUERIES_V1.flatMap((query) =>
    [0, 1].map((round) => run(provider, query.id, query.query, urls(), 10, 0, round)),
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

    // unknown query ids
    const unknown = input({
      runs: [run("a", "q99", "nope", ["https://unitree.com/"], 10, 0, 0)],
      linkValidity: { a: { valid: 1, total: 1 } },
    });
    expect(scoreBenchmark(unknown).completions[0]!.unknownQueries).toEqual(["q99"]);
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

  it("validates numeric measurements (finite, non-negative, legal denominator)", () => {
    const runs = [
      run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], Number.NaN),
      run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], -5),
    ];
    const invalidLatency = input({
      runs,
      linkValidity: { a: { valid: 10, total: 5 } }, // valid > total is illegal
    });
    const scored = scoreBenchmark(invalidLatency);
    for (const raw of scored.raw) {
      expect(Number.isFinite(raw.latencyP50Ms)).toBe(true);
      expect(raw.latencyP50Ms >= 0).toBe(true);
    }
    for (const score of scored.providers) {
      expect(Number.isFinite(score.weightedTotal)).toBe(true);
      expect(score.linkValidity >= 0 && score.linkValidity <= 1).toBe(true);
    }
  });
});
