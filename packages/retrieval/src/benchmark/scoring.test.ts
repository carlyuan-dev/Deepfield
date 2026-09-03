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
  type LinkEvidence,
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

function evidenceFor(runs: readonly BenchmarkedRun[], providers: string[], accessible: boolean | ((url: string) => boolean) = true): Record<string, readonly LinkEvidence[]> {
  const evidence: Record<string, readonly LinkEvidence[]> = {};
  for (const provider of providers) {
    const urls = [...new Set(runs.filter((run) => run.provider === provider).flatMap((run) => run.results.map((result) => result.url)))];
    evidence[provider] = urls.map((url) => ({ url, accessible: typeof accessible === "boolean" ? accessible : accessible(url) }));
  }
  return evidence;
}

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
    const runs = completeRuns("a", (queryId, round) => allDomains.map((url) => `${url}${queryId}${round}`));
    const scored = scoreBenchmark(input({ runs, linkEvidence: evidenceFor(runs, ["a"]) }));
    expect(scored.providers).toHaveLength(1);
    const provider = scored.providers[0]!;
    expect(provider.companyRecall).toBe(1);
    expect(provider.chineseOfficialCoverage).toBe(1);
    expect(provider.linkValidity).toBe(1);
    expect(provider.weightedTotal).toBeCloseTo(1, 5);
  });

  it("uses the link-validity denominator from evidence and never imputes a missing sample", () => {
    const runs = completeRuns("a", () => ["https://unitree.com/", "https://tesla.com/"]);
    const halfAccessible = evidenceFor(runs, ["a"], (url) => url.includes("unitree"));
    const scored = scoreBenchmark(input({ runs, linkEvidence: halfAccessible }));
    expect(scored.raw[0]!.linkValidity).toBe(0.5);
    expect(scored.eligibility.find((entry) => entry.provider === "a")!.reasons).toContain("link validity below 0.95");
    expect(scored.hardGates.fewerThanTwoCompleted).toBe(true);
    // missing evidence for a provider with runs -> fail closed (never imputed)
    expect(() => scoreBenchmark(input({ runs, linkEvidence: {} }))).toThrow(/link ?[eE]vidence/);
  });

  it("computes noise and duplicate rates", () => {
    const runs = completeRuns("a", () => ["https://unitree.com/", "https://unitree.com/", "https://ubtech.com/", "https://tesla.com/"]);
    const scored = scoreBenchmark(input({ runs, linkEvidence: evidenceFor(runs, ["a"]) }));
    const provider = scored.providers[0]!;
    const urls = runs.flatMap((entry) => entry.results.map((result) => result.url));
    expect(provider.duplicateRate).toBeCloseTo(1 - new Set(urls).size / urls.length, 5);
  });

  it("computes p50/p95 latency percentiles", () => {
    const runs = completeRuns("a", () => [], (queryId, round) => {
      const index = Number(queryId.slice(1)) * 2 + round;
      return [100, 200, 300, 400][index % 4]!;
    });
    const scored = scoreBenchmark(input({ runs, linkEvidence: evidenceFor(runs, ["a"]) }));
    expect(scored.raw[0]!.latencyP50Ms).toBe(200);
    expect(scored.raw[0]!.latencyP95Ms).toBe(400);
    expect(percentile([], 50)).toBe(0);
  });

  it("normalizes cost and latency scores across completed providers", () => {
    const runsA = completeRuns("a", () => ["https://unitree.com/", "https://tesla.com/"], () => 100, () => 1);
    const runsB = completeRuns("b", () => ["https://unitree.com/", "https://tesla.com/"], () => 400, () => 5);
    const scored = scoreBenchmark(input({
      runs: [...runsA, ...runsB],
      linkEvidence: evidenceFor([...runsA, ...runsB], ["a", "b"]),
    }));
    const a = scored.providers.find((score) => score.provider === "a")!;
    const b = scored.providers.find((score) => score.provider === "b")!;
    expect(a.costScore).toBe(1);
    expect(b.costScore).toBe(0);
    expect(a.latencyScore).toBe(1);
    expect(b.latencyScore).toBeCloseTo(0.25, 5);
  });

  it("reports hard gates at the benchmark level and per-provider eligibility reasons", () => {
    const runsA = completeRuns("a", () => ["https://unitree.com/"]);
    const runsB = completeRuns("b", () => ["https://unitree.com/", "https://tesla.com/"]);

    const one = input({ runs: runsA, linkEvidence: evidenceFor(runsA, ["a"]) });
    expect(scoreBenchmark(one).hardGates.fewerThanTwoCompleted).toBe(true);

    const lowValidity = input({
      runs: [...runsA, ...runsB],
      linkEvidence: {
        ...evidenceFor(runsA, ["a"], () => false),
        ...evidenceFor(runsB, ["b"], () => true),
      },
    });
    const lowValidityResult = scoreBenchmark(lowValidity);
    expect(lowValidityResult.eligibility.find((entry) => entry.provider === "a")!.reasons).toContain("link validity below 0.95");
    expect(lowValidityResult.eligibility.find((entry) => entry.provider === "a")!.eligible).toBe(false);
    expect(lowValidityResult.eligibility.find((entry) => entry.provider === "b")!.eligible).toBe(true);
    expect(lowValidityResult.hardGates.fewerThanTwoCompleted).toBe(false);

    const emptyRunsA = completeRuns("a", () => []);
    const emptyChinese = input({
      runs: [...emptyRunsA, ...runsB],
      linkEvidence: evidenceFor([...emptyRunsA, ...runsB], ["a", "b"]),
    });
    const emptyChineseResult = scoreBenchmark(emptyChinese);
    expect(emptyChineseResult.eligibility.find((entry) => entry.provider === "a")!.reasons.some((reason) => /chinese query empty: q[1-7]/.test(reason))).toBe(true);
    expect(emptyChineseResult.eligibility.find((entry) => entry.provider === "b")!.eligible).toBe(true);

    const dangerousRuns = completeRuns("a", () => ["https://unitree.com/"]);
    dangerousRuns[0] = { ...dangerousRuns[0]!, results: [{ ...dangerousRuns[0]!.results[0]!, url: "javascript:bad" }] };
    const dangerous = input({
      runs: [...dangerousRuns, ...runsB],
      linkEvidence: evidenceFor([...dangerousRuns, ...runsB], ["a", "b"]),
    });
    const dangerousResult = scoreBenchmark(dangerous);
    expect(dangerousResult.eligibility.find((entry) => entry.provider === "a")!.reasons).toContain("dangerous url");
    expect(dangerousResult.eligibility.find((entry) => entry.provider === "b")!.eligible).toBe(true);

    const missingCategory = input({
      runs: [...runsA, ...runsB],
      linkEvidence: evidenceFor([...runsA, ...runsB], ["a", "b"]),
    });
    const missingCategoryResult = scoreBenchmark(missingCategory);
    expect(missingCategoryResult.eligibility.find((entry) => entry.provider === "a")!.reasons).toContain("category missing: overseas");
    expect(missingCategoryResult.eligibility.find((entry) => entry.provider === "a")!.eligible).toBe(false);
    expect(missingCategoryResult.hardGates.fewerThanTwoCompleted).toBe(false);
  });

  it("never silently imputes a missing provider run", () => {
    const runs = completeRuns("a", () => ["https://unitree.com/", "https://tesla.com/"]);
    const scored = scoreBenchmark(input({ runs, linkEvidence: evidenceFor(runs, ["a"]) }));
    expect(scored.providers).toHaveLength(1);
    expect(scored.providers[0]!.runsCompleted).toBe(20);
  });
});

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

describe("benchmark report writer (focused revision)", () => {
  it("writes atomically into the caller-controlled directory and cleans temp files", () => {
    const directory = mkdtempSync(join(tmpdir(), "df-bench-"));
    try {
      const report: BenchmarkReport = {
        querySetVersion: "v1",
        referenceSetVersion: "v1",
        generatedAt: "2026-08-27T00:00:00.000Z",
        providerConfig: [{ provider: "brave", endpoint: "https://api.search.brave.com/res/v1/web/search", maxResults: 20, runsPerQuery: 2 }],
        failures: [],
        runs: [],
        expectedMeasurements: 20,
        attemptedMeasurements: 0,
        successfulMeasurements: 0,
        benchmarkComplete: false,
        pricing: { brave: { amountPerRequest: 0.01, currency: "USD", usdPerCurrencyUnit: 1, priceSourceUrl: "https://docs.tavily.com/pricing", priceObservedOn: "2026-09-01" } },
        linkEvidence: {},
        linkCheckFailures: [],
        raw: [],
        completions: [],
        eligibility: [],
        scores: [],
        hardGatePassed: false,
        hardGates: { fewerThanTwoCompleted: true, noEligibleProvider: true },
      };
      const target = writeBenchmarkReport(directory, report);
      expect(target).toBe(join(directory, REPORT_FILENAME));
      expect(existsSync(target)).toBe(true);
      const parsed = JSON.parse(readFileSync(target, "utf8")) as BenchmarkReport;
      expect(parsed.querySetVersion).toBe("v1");
      expect(parsed.providerConfig[0]).not.toHaveProperty("apiKey");
      expect(readdirSync(directory).some((name) => name.includes(".tmp"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects relative or traversal directories", () => {
    expect(() => writeBenchmarkReport("relative/path", {} as BenchmarkReport)).toThrow(/directory/i);
    expect(() => writeBenchmarkReport("../escape", {} as BenchmarkReport)).toThrow(/directory/i);
    expect(() => writeBenchmarkReport("", {} as BenchmarkReport)).toThrow(/directory/i);
  });
});
