import { describe, expect, it } from "vitest";
import {
  BenchmarkInputError,
  scoreBenchmark,
  type BenchmarkedRun,
  type BenchmarkScoringInput,
  type LinkEvidence,
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
  const providers = [...new Set(overrides.runs?.map((run) => run.provider) ?? [])];
  return {
    runs: [],
    expectedProviders: providers.length > 0 ? providers : ["a", "b"],
    runsPerQuery: 2,
    linkEvidence: {},
    queries: { version: "v1", queries: QUERIES_V1 },
    reference: { version: "v1", companies: REFERENCE_COMPANIES_V1 },
    ...overrides,
  };
}

/** Builds exact per-provider link evidence from the runs' deduplicated URLs. */
function evidenceFor(runs: readonly Run[], providers: readonly string[] = [], accessible = true): Record<string, readonly LinkEvidence[]> {
  const evidence: Record<string, readonly LinkEvidence[]> = {};
  for (const provider of providers.length > 0 ? providers : [...new Set(runs.map((run) => run.provider))]) {
    const urls = [...new Set(runs.filter((run) => run.provider === provider).flatMap((run) => run.results.map((result) => result.url)))];
    evidence[provider] = urls.map((url) => ({ url, accessible }));
  }
  return evidence;
}

function completeRuns(provider: string, urls: (queryId: string) => string[]): Run[] {
  return QUERIES_V1.flatMap((query) =>
    [0, 1].map((round) => run(provider, query.id, query.query, urls(query.id), 10, 0, round)),
  );
}

describe("benchmark completion and eligibility (focused revision)", () => {
  it("requires every query to complete exactly runsPerQuery times (round identity)", () => {
    const allQueries = QUERIES_V1.flatMap((query) => [0, 1].map((round) => run("a", query.id, query.query, ["https://unitree.com/", "https://tesla.com/"], 10, 0, round)));
    const scored = scoreBenchmark(input({ runs: allQueries, linkEvidence: evidenceFor(allQueries, ["a"]) }));
    expect(scored.completions.find((completion) => completion.provider === "a")!.completed).toBe(true);
    expect(scored.providers).toHaveLength(1);
    expect(scored.providers[0]!.runsCompleted).toBe(20);

    // two providers with one run each are NOT complete
    const partialRuns = [
      run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0),
      run("b", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0),
    ];
    const partial = scoreBenchmark(input({ runs: partialRuns, linkEvidence: evidenceFor(partialRuns, ["a", "b"]) }));
    expect(partial.completions.every((completion) => completion.completed)).toBe(false);
    expect(partial.hardGates.fewerThanTwoCompleted).toBe(true);
    expect(partial.providers).toHaveLength(0);
    expect(partial.raw).toHaveLength(2);

    // 20 duplicate q1 runs are not completion
    const duplicatesRuns = Array.from({ length: 20 }, () => run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0));
    const duplicates = input({ runs: duplicatesRuns, linkEvidence: evidenceFor(duplicatesRuns, ["a"]) });
    expect(scoreBenchmark(duplicates).completions[0]!.completed).toBe(false);

    // missing one query
    const missingRuns = QUERIES_V1.slice(0, 9).flatMap((query) => [0, 1].map((round) => run("a", query.id, query.query, ["https://unitree.com/"], 10, 0, round)));
    const missingOne = input({ runs: missingRuns, linkEvidence: evidenceFor(missingRuns, ["a"]) });
    const missingResult = scoreBenchmark(missingOne);
    expect(missingResult.completions[0]!.completed).toBe(false);
    expect(missingResult.completions[0]!.missing).toEqual(["q10"]);

    // duplicate rounds
    const dupRuns = [
      run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0),
      run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0),
    ];
    const dupRounds = input({ runs: dupRuns, linkEvidence: evidenceFor(dupRuns, ["a"]) });
    expect(scoreBenchmark(dupRounds).completions[0]!.duplicateRounds).toEqual(["q1:0"]);

    // unknown query ids fail closed
    expect(() => scoreBenchmark(input({
      runs: [run("a", "q99", "nope", ["https://unitree.com/"], 10, 0, 0)],
      linkEvidence: evidenceFor([run("a", "q99", "nope", ["https://unitree.com/"], 10, 0, 0)], ["a"]),
    }))).toThrow(BenchmarkInputError);
  });

  it("reports per-provider eligibility without poisoning other providers", () => {
    const allQueries = (provider: string) =>
      QUERIES_V1.flatMap((query) => [0, 1].map((round) => run(provider, query.id, query.query, ["https://unitree.com/", "https://tesla.com/"], 10, 0, round)));
    const runs = [...allQueries("a"), ...allQueries("b"), ...allQueries("c")];
    const dangerousRunIndex = runs.findIndex((entry) => entry.provider === "a");
    runs[dangerousRunIndex] = { ...runs[dangerousRunIndex]!, results: [{ ...runs[dangerousRunIndex]!.results[0]!, url: "javascript:bad" }] };
    const scored = scoreBenchmark(input({ runs, linkEvidence: evidenceFor(runs, ["a", "b", "c"]) }));
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
    const badLatency = [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], Number.NaN)];
    expect(() => scoreBenchmark(input({ runs: badLatency, linkEvidence: evidenceFor(badLatency, ["a"]) }))).toThrow(/latencyMs/);

    const negLatency = [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], -5)];
    expect(() => scoreBenchmark(input({ runs: negLatency, linkEvidence: evidenceFor(negLatency, ["a"]) }))).toThrow(/latencyMs/);

    const negCost = [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, -1)];
    expect(() => scoreBenchmark(input({ runs: negCost, linkEvidence: evidenceFor(negCost, ["a"]) }))).toThrow(/costUsd/);

    // wrong round identity and unknown query ids
    const badRound = [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 5)];
    expect(() => scoreBenchmark(input({ runs: badRound, linkEvidence: evidenceFor(badRound, ["a"]) }))).toThrow(/round/);
    const unknownRun = [run("a", "q99", "nope", ["https://unitree.com/"], 10)];
    expect(() => scoreBenchmark(input({ runs: unknownRun, linkEvidence: evidenceFor(unknownRun, ["a"]) }))).toThrow(/unknown query/);
  });

  it("validates the link denominator itself from per-URL evidence (public boundary)", () => {
    const runs = [
      run("a", "q1", "人形机器人 公司", ["https://unitree.com/", "https://tesla.com/"], 10, 0, 0),
      run("a", "q1", "人形机器人 公司", ["https://unitree.com/", "https://tesla.com/"], 10, 0, 1),
    ];
    // 2 unique result URLs but a 1-entry evidence set: MUST fail closed
    expect(() => scoreBenchmark(input({
      runs,
      linkEvidence: { a: [{ url: "https://unitree.com/", accessible: true }] },
    }))).toThrow(/link ?[eE]vidence/);

    // unknown provider evidence is rejected
    expect(() => scoreBenchmark(input({
      runs,
      linkEvidence: { nope: [{ url: "https://unitree.com/", accessible: true }] },
    }))).toThrow(/link ?[eE]vidence/);

    // duplicate evidence urls are rejected
    expect(() => scoreBenchmark(input({
      runs,
      linkEvidence: {
        a: [
          { url: "https://unitree.com/", accessible: true },
          { url: "https://unitree.com/", accessible: true },
        ],
      },
    }))).toThrow(/link ?[eE]vidence/);

    // exact evidence passes and derives valid/total (2/2)
    const scored = scoreBenchmark(input({ runs, linkEvidence: evidenceFor(runs, ["a"]) }));
    expect(scored.raw[0]!.linkValidity).toBe(1);
  });

  it("rejects any evidence for a zero-run provider (expected set is empty)", () => {
    // the main-window repro: zero runs but fabricated evidence for provider a
    expect(() => scoreBenchmark(input({
      runs: [],
      expectedProviders: ["a"],
      linkEvidence: { a: [{ url: "https://unchecked.example/", accessible: true }] },
    }))).toThrow(/link ?[eE]vidence/);
    // empty evidence for a zero-run provider is legal
    const scored = scoreBenchmark(input({ runs: [], expectedProviders: ["a"], linkEvidence: { a: [] } }));
    expect(scored.completions[0]!.completed).toBe(false);
  });

  it("requires linkEvidence keys to EXACTLY match expectedProviders", () => {
    // extra unknown key alongside a legal one
    expect(() => scoreBenchmark(input({
      runs: [],
      expectedProviders: ["a"],
      linkEvidence: { a: [], attacker: [{ url: "https://attacker.example/", accessible: true }] },
    }))).toThrow(/link ?[eE]vidence/);
    // missing key for an expected provider
    expect(() => scoreBenchmark(input({
      runs: [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 10, 0, 0)],
      expectedProviders: ["a", "b"],
      linkEvidence: { a: [{ url: "https://unitree.com/", accessible: true }] },
    }))).toThrow(/link ?[eE]vidence/);
  });

  it("rejects linkCheckFailures outside expectedProviders, with duplicates or illegal values", () => {
    const runs = completeRuns("a", () => ["https://unitree.com/", "https://tesla.com/"]);
    expect(() => scoreBenchmark(input({
      runs,
      expectedProviders: ["a", "b"],
      linkEvidence: evidenceFor(runs, ["a"]),
      linkCheckFailures: ["attacker"],
    }))).toThrow(/linkCheckFailures/);
    expect(() => scoreBenchmark(input({
      runs,
      expectedProviders: ["a", "b"],
      linkEvidence: evidenceFor(runs, ["a"]),
      linkCheckFailures: ["a", "a"],
    }))).toThrow(/linkCheckFailures/);
    expect(() => scoreBenchmark(input({
      runs,
      expectedProviders: ["a", "b"],
      linkEvidence: evidenceFor(runs, ["a"]),
      linkCheckFailures: [42 as never],
    }))).toThrow(/linkCheckFailures/);
  });

  it("allows partial evidence ONLY as a real subset of the expected set under infra failure", () => {
    const runs = [run("a", "q1", "人形机器人 公司", ["https://unitree.com/", "https://tesla.com/"], 10, 0, 0)];
    // infra failure + real partial evidence (unitree checked, tesla not yet) is legal
    const scored = scoreBenchmark(input({
      runs,
      expectedProviders: ["a"],
      linkEvidence: { a: [{ url: "https://unitree.com/", accessible: true }] },
      linkCheckFailures: ["a"],
    }));
    expect(scored.eligibility.find((entry) => entry.provider === "a")!.reasons).toContain("link check infrastructure failure");
    // infra failure does NOT excuse unknown/forged urls in the partial evidence
    expect(() => scoreBenchmark(input({
      runs,
      expectedProviders: ["a"],
      linkEvidence: { a: [{ url: "https://forged.example/", accessible: true }] },
      linkCheckFailures: ["a"],
    }))).toThrow(/link ?[eE]vidence/);
  });

  it("reports expected providers with zero successful runs as incomplete (do not vanish)", () => {
    const runs = completeRuns("tavily", () => ["https://unitree.com/", "https://tesla.com/"]);
    const scored = scoreBenchmark(input({
      runs,
      expectedProviders: ["brave", "tavily"],
      linkEvidence: evidenceFor(runs, ["brave", "tavily"]),
    }));
    const braveCompletion = scored.completions.find((completion) => completion.provider === "brave")!;
    expect(braveCompletion).toBeDefined();
    expect(braveCompletion.completed).toBe(false);
    expect(braveCompletion.runCount).toBe(0);
    expect(braveCompletion.expectedCount).toBe(20);
    expect(braveCompletion.missing).toEqual(QUERIES_V1.map((query) => query.id));
    const braveEligibility = scored.eligibility.find((entry) => entry.provider === "brave")!;
    expect(braveEligibility.eligible).toBe(false);
    const braveRaw = scored.raw.find((entry) => entry.provider === "brave")!;
    expect(braveRaw.completed).toBe(false);
    expect(braveRaw.runsCompleted).toBe(0);
    expect(scored.completions.find((completion) => completion.provider === "tavily")!.completed).toBe(true);
    expect(scored.hardGates.fewerThanTwoCompleted).toBe(true);
  });

  it("requires EVERY fixed Chinese query to have results (q1 alone is not enough)", () => {
    const runs = completeRuns("a", (queryId) => (queryId === "q1" ? ["https://unitree.com/"] : []));
    const goodB = completeRuns("b", () => ["https://unitree.com/", "https://tesla.com/"]);
    const scored = scoreBenchmark(input({ runs: [...runs, ...goodB], linkEvidence: evidenceFor([...runs, ...goodB], ["a", "b"]) }));
    const eligibilityA = scored.eligibility.find((entry) => entry.provider === "a")!;
    expect(eligibilityA.eligible).toBe(false);
    expect(eligibilityA.reasons.some((reason) => /chinese query empty: q[2-7]/.test(reason))).toBe(true);
    expect(eligibilityA.reasons).not.toContain("chinese query empty: q1");
    expect(scored.eligibility.find((entry) => entry.provider === "b")!.eligible).toBe(true);
  });

  it("requires the run query text to match the frozen query set (fail closed)", () => {
    const runs = completeRuns("a", () => ["https://unitree.com/", "https://tesla.com/"]);
    const target = runs.find((entry) => entry.queryId === "q1")!;
    target.query = "篡改的查询文本";
    expect(() => scoreBenchmark(input({ runs, linkEvidence: evidenceFor(runs, ["a"]) }))).toThrow(/query text mismatch/);
  });
});
