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

function run(provider: string, queryId: string, query: string, urls: string[], latencyMs = 100, costUsd = 0): BenchmarkedRun {
  return {
    provider,
    queryId,
    query,
    results: urls.map((url) => ({ ...result(url), rank: urls.indexOf(url) + 1 })),
    latencyMs,
    costUsd,
  };
}

function input(overrides: Partial<BenchmarkScoringInput> = {}): BenchmarkScoringInput {
  return {
    runs: [],
    linkValidity: {},
    queries: { version: "v1", queries: QUERIES_V1 },
    reference: { version: "v1", companies: REFERENCE_COMPANIES_V1 },
    ...overrides,
  };
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
    const runs = [
      run("a", "q1", "人形机器人 公司", [
        "https://www.tesla.com/", "https://figure.ai/", "https://agilityrobotics.com/", "https://apptronik.com/",
        "https://1x.tech/", "https://bostondynamics.com/", "https://unitree.com/", "https://ubtech.com/",
        "https://fft-ai.com/", "https://zhiyuan-robot.com/", "https://galbot.com/", "https://engine-ai.cn/",
      ]),
    ];
    const scored = scoreBenchmark(input({ runs, linkValidity: { a: { valid: 12, total: 12 } } }));
    expect(scored.providers).toHaveLength(1);
    const provider = scored.providers[0]!;
    expect(provider.companyRecall).toBe(1);
    expect(provider.chineseOfficialCoverage).toBe(1);
    expect(provider.linkValidity).toBe(1);
    // expected weighted total with perfect scores (cost/latency across one provider = 1)
    expect(provider.weightedTotal).toBeCloseTo(1, 5);
  });

  it("uses the link-validity denominator and never imputes a missing sample", () => {
    const runs = [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"])];
    const withSample: LinkValiditySample = { valid: 8, total: 10 };
    const scored = scoreBenchmark(input({ runs, linkValidity: { a: withSample } }));
    expect(scored.providers[0]!.linkValidity).toBe(0.8);
    expect(scored.hardGates.linkValidityBelow95).toBe(true);
    const missing = scoreBenchmark(input({ runs, linkValidity: {} }));
    expect(missing.providers[0]!.linkValidity).toBe(0); // never imputed
  });

  it("computes noise and duplicate rates", () => {
    const runs = [
      run("a", "q1", "人形机器人 公司", ["https://unitree.com/", "https://unitree.com/", "https://ubtech.com/"]),
    ];
    const scored = scoreBenchmark(input({ runs, linkValidity: { a: { valid: 3, total: 3 } } }));
    const provider = scored.providers[0]!;
    expect(provider.duplicateRate).toBeCloseTo(1 / 3, 5);
  });

  it("computes p50/p95 latency percentiles", () => {
    const runs = [
      run("a", "q1", "x", [], 100),
      run("a", "q2", "y", [], 200),
      run("a", "q3", "z", [], 300),
      run("a", "q4", "w", [], 400),
    ];
    const scored = scoreBenchmark(input({ runs, linkValidity: { a: { valid: 0, total: 0 } } }));
    expect(scored.providers[0]!.latencyP50Ms).toBe(200);
    expect(scored.providers[0]!.latencyP95Ms).toBe(400);
    expect(percentile([], 50)).toBe(0);
  });

  it("normalizes cost and latency scores across completed providers", () => {
    const runsA = [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"], 100, 1)];
    const runsB = [run("b", "q1", "人形机器人 公司", ["https://unitree.com/"], 400, 5)];
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

  it("fails hard gates: fewer than two providers, link validity <95%, empty Chinese queries, dangerous URL, missing category", () => {
    const one = input({
      runs: [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"])],
      linkValidity: { a: { valid: 1, total: 1 } },
    });
    expect(scoreBenchmark(one).hardGates.fewerThanTwoProviders).toBe(true);

    const lowValidity = input({
      runs: [
        run("a", "q1", "人形机器人 公司", ["https://unitree.com/"]),
        run("b", "q1", "人形机器人 公司", ["https://unitree.com/"]),
      ],
      linkValidity: { a: { valid: 9, total: 10 }, b: { valid: 10, total: 10 } },
    });
    expect(scoreBenchmark(lowValidity).hardGates.linkValidityBelow95).toBe(true);

    const emptyChinese = input({
      runs: [
        run("a", "q1", "人形机器人 公司", []),
        run("b", "q1", "人形机器人 公司", ["https://unitree.com/"]),
      ],
      linkValidity: { a: { valid: 10, total: 10 }, b: { valid: 10, total: 10 } },
    });
    expect(scoreBenchmark(emptyChinese).hardGates.chineseEmpty).toBe(true);

    const dangerous = input({
      runs: [
        run("a", "q1", "人形机器人 公司", ["https://unitree.com/"]),
        run("b", "q1", "人形机器人 公司", ["javascript:bad"]),
      ],
      linkValidity: { a: { valid: 10, total: 10 }, b: { valid: 10, total: 10 } },
    });
    expect(scoreBenchmark(dangerous).hardGates.dangerousUrl).toBe(true);

    const missingCategory = input({
      runs: [
        run("a", "q1", "人形机器人 公司", ["https://unitree.com/"]),
        run("b", "q1", "人形机器人 公司", ["https://unitree.com/"]),
      ],
      linkValidity: { a: { valid: 10, total: 10 }, b: { valid: 10, total: 10 } },
    });
    // neither provider matches ANY overseas company -> systematic category missing
    expect(scoreBenchmark(missingCategory).hardGates.categoryMissing).toBe(true);
  });

  it("never silently imputes a missing provider run", () => {
    const runs = [run("a", "q1", "人形机器人 公司", ["https://unitree.com/"])];
    const scored = scoreBenchmark(input({ runs, linkValidity: { a: { valid: 1, total: 1 } } }));
    expect(scored.providers).toHaveLength(1);
    expect(scored.providers[0]!.runsCompleted).toBe(1);
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
        scores: [],
        hardGatePassed: true,
        hardGates: { fewerThanTwoProviders: false, linkValidityBelow95: false, chineseEmpty: false, dangerousUrl: false, categoryMissing: false },
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
