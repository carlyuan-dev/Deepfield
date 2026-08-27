import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchesCompanyDomain,
  normalizeDomain,
  percentile,
  scoreBenchmark,
  type BenchmarkedRun,
  type BenchmarkScoringInput,
  type LinkValiditySample,
} from "./scoring.js";
import { writeBenchmarkReport, REPORT_FILENAME, type BenchmarkReport } from "./report.js";
import { QUERIES_V1, readQueriesV1 } from "./queries.js";
import { REFERENCE_COMPANIES_V1, readReferenceCompaniesV1 } from "./reference-companies.js";

function result(url: string, title = "t", snippet = "s"): import("../search-provider.js").NormalizedSearchResult {
  return { title, url, snippet, rank: 1, provider: "p" };
}

function run(provider: string, queryId: string, query: string, urls: string[], latencyMs = 100, costUsd = 0, round = 0): BenchmarkedRun {
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

/** A complete run set: every query exactly runsPerQuery times with unique rounds. */
function completeRuns(
  provider: string,
  urls: (queryId: string, round: number) => string[],
  latencyMs: (queryId: string, round: number) => number = () => 100,
  costUsd: (queryId: string, round: number) => number = () => 0,
): BenchmarkedRun[] {
  return QUERIES_V1.flatMap((query) =>
    [0, 1].map((round) =>
      run(provider, query.id, query.query, urls(query.id, round), latencyMs(query.id, round), costUsd(query.id, round), round),
    ),
  );
}

describe("benchmark scoring (focused revision)", () => {
  it("matches companies by normalized domain (www-stripped, suffix-safe)", () => {
    expect(matchesCompanyDomain("https://www.Unitree.com/products", ["unitree.com"])).toBe(true);
    expect(matchesCompanyDomain("https://news.ubtech.com/x", ["ubtech.com"])).toBe(true);
    expect(matchesCompanyDomain("https://unitree.example.com/", ["unitree.com"])).toBe(false);
    expect(normalizeDomain("WWW.Tesla.COM")).toBe("tesla.com");
    expect(normalizeDomain("www.1x.tech")).toBe("1x.tech");
  });

  it("computes company recall and Chinese official-site coverage with the right weight", () => {
    const allDomains = [
      "https://www.tesla.com/", "https://figure.ai/", "https://agilityrobotics.com/", "https://apptronik.com/",
      "https://1x.tech/", "https://bostondynamics.com/", "https://unitree.com/", "https://ubtech.com/",
      "https://fft-ai.com/", "https://zhiyuan-robot.com/", "https://galbot.com/", "https://engine-ai.cn/",
    ];
    // unique URLs per run (query/round-specific paths) while keeping the domains
    const runs = completeRuns("a", (queryId, round) => allDomains.map((url) => `${url}${queryId}${round}`));
    const scored = scoreBenchmark(input({ runs, linkValidity: { a: { valid: 24, total: 24 } } }));
    expect(scored.providers).toHaveLength(1);
    const provider = scored.providers[0]!;
    expect(provider.companyRecall).toBe(1);
    expect(provider.chineseOfficialCoverage).toBe(1);
    expect(provider.linkValidity).toBe(1);
    // expected weighted total with perfect scores (cost/latency across one provider = 1)
    expect(provider.weightedTotal).toBeCloseTo(1, 5);
  });

  it("uses the link-validity denominator and never imputes a missing sample", () => {
    const runs = completeRuns("a", () => ["https://unitree.com/"]);
    const withSample: LinkValiditySample = { valid: 8, total: 10 };
    const scored = scoreBenchmark(input({ runs, linkValidity: { a: withSample } }));
    expect(scored.raw[0]!.linkValidity).toBe(0.8);
    expect(scored.eligibility.find((entry) => entry.provider === "a")!.reasons).toContain("link validity below 0.95");
    expect(scored.hardGates.fewerThanTwoCompleted).toBe(true); // only one provider
    const missing = scoreBenchmark(input({ runs, linkValidity: {} }));
    expect(missing.raw[0]!.linkValidity).toBe(0); // never imputed
  });

  it("computes noise and duplicate rates", () => {
    const runs = completeRuns("a", () => ["https://unitree.com/", "https://unitree.com/", "https://ubtech.com/", "https://tesla.com/"]);
    const scored = scoreBenchmark(input({ runs, linkValidity: { a: { valid: 3, total: 3 } } }));
    const provider = scored.providers[0]!;
    const urls = runs.flatMap((entry) => entry.results.map((result) => result.url));
    expect(provider.duplicateRate).toBeCloseTo(1 - new Set(urls).size / urls.length, 5);
  });

  it("computes p50/p95 latency percentiles", () => {
    // latencies cycle 100/200/300/400 across runs; p50 = 250, p95 = 400
    const runs = completeRuns("a", () => [], (queryId, round) => {
      const index = Number(queryId.slice(1)) * 2 + round;
      return [100, 200, 300, 400][index % 4]!;
    });
    const scored = scoreBenchmark(input({ runs, linkValidity: { a: { valid: 0, total: 0 } } }));
    expect(scored.raw[0]!.latencyP50Ms).toBe(200);
    expect(scored.raw[0]!.latencyP95Ms).toBe(400);
    expect(percentile([], 50)).toBe(0);
  });

  it("normalizes cost and latency scores across completed providers", () => {
    const runsA = completeRuns("a", () => ["https://unitree.com/", "https://tesla.com/"], () => 100, () => 1);
    const runsB = completeRuns("b", () => ["https://unitree.com/", "https://tesla.com/"], () => 400, () => 5);
    const scored = scoreBenchmark(input({
      runs: [...runsA, ...runsB],
      linkValidity: { a: { valid: 1, total: 1 }, b: { valid: 1, total: 1 } },
    }));
    const a = scored.providers.find((score) => score.provider === "a")!;
    const b = scored.providers.find((score) => score.provider === "b")!;
    expect(a.costScore).toBe(1);
    expect(b.costScore).toBe(0);
    expect(a.latencyScore).toBe(1);
    expect(b.latencyScore).toBeCloseTo(0.25, 5);
  });

  it("reports hard gates at the benchmark level and per-provider eligibility reasons", () => {
    // only one provider -> fewerThanTwoCompleted
    const one = input({
      runs: completeRuns("a", () => ["https://unitree.com/"]),
      linkValidity: { a: { valid: 20, total: 20 } },
    });
    expect(scoreBenchmark(one).hardGates.fewerThanTwoCompleted).toBe(true);

    // low link validity is a per-provider reason, not a global gate
    const lowValidity = input({
      runs: [
        ...completeRuns("a", () => ["https://unitree.com/"]),
        ...completeRuns("b", () => ["https://unitree.com/", "https://tesla.com/"]),
      ],
      linkValidity: { a: { valid: 9, total: 10 }, b: { valid: 10, total: 10 } },
    });
    const lowValidityResult = scoreBenchmark(lowValidity);
    expect(lowValidityResult.eligibility.find((entry) => entry.provider === "a")!.reasons).toContain("link validity below 0.95");
    expect(lowValidityResult.eligibility.find((entry) => entry.provider === "a")!.eligible).toBe(false);
    expect(lowValidityResult.eligibility.find((entry) => entry.provider === "b")!.eligible).toBe(true);
    expect(lowValidityResult.hardGates.fewerThanTwoCompleted).toBe(false);

    // empty Chinese queries -> per-provider reason
    const emptyChinese = input({
      runs: [
        ...completeRuns("a", () => []),
        ...completeRuns("b", () => ["https://unitree.com/", "https://tesla.com/"]),
      ],
      linkValidity: { a: { valid: 20, total: 20 }, b: { valid: 20, total: 20 } },
    });
    const emptyChineseResult = scoreBenchmark(emptyChinese);
    expect(emptyChineseResult.eligibility.find((entry) => entry.provider === "a")!.reasons.some((reason) => /chinese query empty: q[1-7]/.test(reason))).toBe(true);
    expect(emptyChineseResult.eligibility.find((entry) => entry.provider === "b")!.eligible).toBe(true);

    // dangerous URL -> per-provider reason
    const dangerousRuns = completeRuns("a", () => ["https://unitree.com/"]);
    dangerousRuns[0] = { ...dangerousRuns[0]!, results: [{ ...dangerousRuns[0]!.results[0]!, url: "javascript:bad" }] };
    const dangerous = input({
      runs: [...dangerousRuns, ...completeRuns("b", () => ["https://unitree.com/", "https://tesla.com/"])],
      linkValidity: { a: { valid: 20, total: 20 }, b: { valid: 20, total: 20 } },
    });
    const dangerousResult = scoreBenchmark(dangerous);
    expect(dangerousResult.eligibility.find((entry) => entry.provider === "a")!.reasons).toContain("dangerous url");
    expect(dangerousResult.eligibility.find((entry) => entry.provider === "b")!.eligible).toBe(true);

    // category missing -> per-provider reason
    const missingCategory = input({
      runs: [
        ...completeRuns("a", () => ["https://unitree.com/"]),
        ...completeRuns("b", () => ["https://unitree.com/", "https://tesla.com/"]),
      ],
      linkValidity: { a: { valid: 20, total: 20 }, b: { valid: 20, total: 20 } },
    });
    const missingCategoryResult = scoreBenchmark(missingCategory);
    expect(missingCategoryResult.eligibility.find((entry) => entry.provider === "a")!.reasons).toContain("category missing: overseas");
    expect(missingCategoryResult.eligibility.find((entry) => entry.provider === "a")!.eligible).toBe(false);
    expect(missingCategoryResult.hardGates.fewerThanTwoCompleted).toBe(false); // both completed; the gate is per-provider
  });

  it("never silently imputes a missing provider run", () => {
    const runs = completeRuns("a", () => ["https://unitree.com/", "https://tesla.com/"]);
    const scored = scoreBenchmark(input({ runs, linkValidity: { a: { valid: 20, total: 20 } } }));
    expect(scored.providers).toHaveLength(1);
    expect(scored.providers[0]!.runsCompleted).toBe(20);
  });});

describe("benchmark frozen v1 data (focused revision)", () => {
  it("keeps the TypeScript constants and JSON files consistent", () => {
    const queries = readQueriesV1();
    const companies = readReferenceCompaniesV1();
    expect(queries.queries.map((query) => query.query)).toEqual(QUERIES_V1.map((query) => query.query));
    expect(companies.companies.map((company) => company.id)).toEqual(REFERENCE_COMPANIES_V1.map((company) => company.id));
    expect(queries.queries).toHaveLength(10);
    expect(companies.companies).toHaveLength(12);
  });
});
