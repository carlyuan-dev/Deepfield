import { describe, expect, it } from "vitest";
import { runBenchmark, BenchmarkInputError, type BenchmarkHarnessDeps, type HarnessProvider, type LinkChecker } from "./run-benchmark.js";
import type { ProviderPrice } from "./pricing.js";
import type { BenchmarkReport } from "./report.js";
import type { NormalizedSearchResponse } from "../search-provider.js";
import { QUERIES_V1 } from "./queries.js";
import { REFERENCE_COMPANIES_V1 } from "./reference-companies.js";

const USD_TAVILY: ProviderPrice = {
  amountPerRequest: 0.01,
  currency: "USD",
  usdPerCurrencyUnit: 1,
  priceSourceUrl: "https://docs.tavily.com/pricing",
  priceObservedOn: "2026-09-01",
};

const CNY_BAIDU: ProviderPrice = {
  amountPerRequest: 0.036,
  currency: "CNY",
  usdPerCurrencyUnit: 0.14,
  priceSourceUrl: "https://cloud.baidu.com/pricing",
  priceObservedOn: "2026-09-01",
  exchangeRateSourceUrl: "https://example.com/fx",
  exchangeRateObservedOn: "2026-09-01",
};

function fakeProvider(id: "brave" | "tavily", opts: { failQueries?: Set<string>; urls?: (queryId: string, round: number) => string[] } = {}): HarnessProvider {
  return {
    id,
    endpoint: `https://${id}.example`,
    async search(query, maxResults, _signal) {
      if (opts.failQueries !== undefined) {
        const hit = QUERIES_V1.find((entry) => entry.query === query);
        if (hit !== undefined && opts.failQueries.has(hit.id)) {
          throw new Error(`provider ${id} failed ${hit.id}`);
        }
      }
      const urls = opts.urls !== undefined ? opts.urls("", 0) : [`https://${id}.example/${encodeURIComponent(query)}`];
      const response: NormalizedSearchResponse = {
        provider: id,
        results: urls.map((url, index) => ({ title: `t${index}`, url, snippet: "s", rank: index + 1, provider: id })),
      };
      return response;
    },
  };
}

class FakeLinkChecker implements LinkChecker {
  readonly checks: Array<{ url: string }> = [];
  private readonly accessible: Map<string, boolean>;
  private readonly infraFailOn: Set<string>;

  constructor(accessible: Map<string, boolean>, infraFailOn: Set<string> = new Set()) {
    this.accessible = accessible;
    this.infraFailOn = infraFailOn;
  }

  async check(url: string, signal: AbortSignal): Promise<{ url: string; accessible: boolean }> {
    if (signal.aborted) {
      throw new Error("cancelled");
    }
    this.checks.push({ url });
    if (this.infraFailOn.has(url)) {
      throw new Error("infra boom");
    }
    return { url, accessible: this.accessible.get(url) ?? true };
  }
}

function harnessDeps(overrides: Partial<BenchmarkHarnessDeps> = {}): BenchmarkHarnessDeps {
  return {
    providers: [fakeProvider("brave"), fakeProvider("tavily")],
    runsPerQuery: 2,
    maxResults: 20,
    linkChecker: new FakeLinkChecker(new Map()),
    pricing: { brave: USD_TAVILY, tavily: CNY_BAIDU },
    writer: () => {},
    ...overrides,
  };
}

describe("benchmark harness state machine (focused revision)", () => {
  it("fixes expectedMeasurements up front (first checkpoint already shows the full expected count)", async () => {
    const checkpoints: BenchmarkReport[] = [];
    const report = await runBenchmark(harnessDeps({ writer: (entry) => checkpoints.push(entry) }));
    expect(report.expectedMeasurements).toBe(40);
    expect(checkpoints[0]!.expectedMeasurements).toBe(40);
    expect(checkpoints[0]!.attemptedMeasurements).toBe(1);
    expect(checkpoints[0]!.successfulMeasurements).toBe(1);
    expect(checkpoints[0]!.benchmarkComplete).toBe(false);
    expect(report.benchmarkComplete).toBe(true);
    expect(report.attemptedMeasurements).toBe(40);
    expect(report.successfulMeasurements).toBe(40);
  });

  it("checks each unique URL exactly once across providers and rounds (global cache)", async () => {
    const sharedUrl = "https://shared.example/";
    const checker = new FakeLinkChecker(new Map([[sharedUrl, true]]));
    const report = await runBenchmark(harnessDeps({
      providers: [
        fakeProvider("brave", { urls: () => [sharedUrl] }),
        fakeProvider("tavily", { urls: () => [sharedUrl] }),
      ],
      linkChecker: checker,
    }));
    expect(report.attemptedMeasurements).toBe(40);
    // 2 providers x 10 queries x 2 rounds all return the SAME url: only 1 check
    expect(checker.checks).toHaveLength(1);
    expect(checker.checks[0]!.url).toBe(sharedUrl);
  });

  it("scales link checks with unique URLs, not measurements x growing sets", async () => {
    const checker = new FakeLinkChecker(new Map());
    await runBenchmark(harnessDeps({
      providers: [
        fakeProvider("brave", { urls: () => ["https://a.example/1", "https://a.example/2"] }),
        fakeProvider("tavily", { urls: () => ["https://a.example/2", "https://a.example/3"] }),
      ],
      linkChecker: checker,
    }));
    expect(checker.checks).toHaveLength(3); // unique urls: /1 /2 /3
  });

  it("increments attempted on failures too (failed attempts never masquerade as runs)", async () => {
    const checkpoints: BenchmarkReport[] = [];
    const report = await runBenchmark(harnessDeps({
      providers: [
        fakeProvider("brave", { failQueries: new Set(["q1"]) }),
        fakeProvider("tavily", { failQueries: new Set(["q1"]) }),
      ],
      writer: (entry) => checkpoints.push(entry),
    }));
    expect(report.attemptedMeasurements).toBe(40);
    expect(report.successfulMeasurements).toBe(36);
    expect(report.failures.length).toBe(4);
    expect(report.runs.every((run) => run.queryId !== "q1" || run.results.length > 0)).toBe(true);
    expect(checkpoints[checkpoints.length - 1]!.benchmarkComplete).toBe(true);
  });

  it("keeps the last checkpoint on interrupt with benchmarkComplete=false", async () => {
    const controller = new AbortController();
    const checkpoints: BenchmarkReport[] = [];
    let count = 0;
    const report = await runBenchmark(harnessDeps({
      signal: controller.signal,
      writer: (entry) => {
        checkpoints.push(entry);
        count += 1;
        if (count === 20) {
          controller.abort();
        }
      },
    }));
    expect(report.benchmarkComplete).toBe(false);
    expect(report.attemptedMeasurements).toBe(20);
    expect(report.hardGatePassed).toBe(false);
    expect(checkpoints[checkpoints.length - 1]!.benchmarkComplete).toBe(false);
  });

  it("rejects illegal pricing and config before any measurement", async () => {
    await expect(runBenchmark(harnessDeps({ pricing: { brave: { ...USD_TAVILY, amountPerRequest: -1 }, tavily: CNY_BAIDU } }))).rejects.toThrow(/pricing/);
    await expect(runBenchmark(harnessDeps({ pricing: { brave: { ...USD_TAVILY, amountPerRequest: Number.NaN }, tavily: CNY_BAIDU } }))).rejects.toThrow(/pricing/);
    await expect(runBenchmark(harnessDeps({ pricing: { brave: USD_TAVILY } }))).rejects.toThrow(/pricing/);
    await expect(runBenchmark(harnessDeps({ runsPerQuery: 0 }))).rejects.toThrow(BenchmarkInputError);
    await expect(runBenchmark(harnessDeps({ providers: [fakeProvider("brave")] }))).rejects.toThrow(/at least two/);
  });

  it("records stable sanitized failures (no raw provider/link error messages or urls)", async () => {
    const report = await runBenchmark(harnessDeps({
      providers: [
        fakeProvider("brave", { failQueries: new Set(["q1"]), urls: () => ["https://x.example/"] }),
        fakeProvider("tavily"),
      ],
      linkChecker: new FakeLinkChecker(new Map([["https://x.example/", true]]), new Set(["https://x.example/"])),
    }));
    for (const failure of report.failures) {
      expect(failure).not.toMatch(/provider brave failed q1/); // raw message stripped
      expect(failure).not.toContain("https://x.example/"); // urls never in failures
    }
    expect(report.failures.some((failure) => failure.includes("provider_failed"))).toBe(true);
    expect(report.failures.some((failure) => failure.includes("link_check_failed"))).toBe(true);
  });

  it("never fabricates accessible=false for an unchecked URL after an infra error", async () => {
    const url = "https://unchecked.example/";
    const checkpoints: Array<{ linkEvidence: Record<string, unknown>; linkCheckFailures: string[] }> = [];
    const report = await runBenchmark(harnessDeps({
      providers: [
        fakeProvider("brave", { urls: () => [url] }),
        fakeProvider("tavily"),
      ],
      linkChecker: new FakeLinkChecker(new Map(), new Set([url])), // infra error on this url
      writer: (entry) => {
        checkpoints.push({ linkEvidence: entry.linkEvidence, linkCheckFailures: entry.linkCheckFailures });
      },
    }));
    // the url NEVER got a checker outcome: no fabricated {accessible:false} evidence
    for (const checkpoint of checkpoints) {
      const braveEvidence = checkpoint.linkEvidence["brave"] as Array<{ url: string; accessible: boolean }>;
      expect(braveEvidence.every((entry) => entry.url !== url)).toBe(true);
    }
    // the provider is marked with the stable infra failure instead
    expect(report.linkCheckFailures).toContain("brave");
    expect(report.failures.some((failure) => failure.includes("link_check_failed"))).toBe(true);
    // a DIFFERENT provider successfully checking the same url later projects the real outcome
    const shared = "https://shared.example/";
    const checkpoints2: Array<Record<string, unknown>> = [];
    await runBenchmark(harnessDeps({
      providers: [
        fakeProvider("brave", { urls: () => [shared] }),
        fakeProvider("tavily", { urls: () => [shared] }),
      ],
      linkChecker: new FakeLinkChecker(new Map([[shared, true]])),
      writer: (entry) => checkpoints2.push(entry.linkEvidence),
    }));
    const lastCheckpoint = checkpoints2[checkpoints2.length - 1]!;
    const tavilyEvidence = lastCheckpoint["tavily"] as Array<{ url: string; accessible: boolean }>;
    expect(tavilyEvidence.some((entry) => entry.url === shared && entry.accessible === true)).toBe(true);
  });

  it("reports a provider with zero successful runs as incomplete (does not vanish)", async () => {
    const report = await runBenchmark(harnessDeps({
      providers: [
        fakeProvider("brave", { failQueries: new Set(QUERIES_V1.map((query) => query.id)) }),
        fakeProvider("tavily"),
      ],
    }));
    const braveCompletion = report.completions.find((completion) => completion.provider === "brave")!;
    expect(braveCompletion).toBeDefined();
    expect(braveCompletion.completed).toBe(false);
    expect(braveCompletion.runCount).toBe(0);
    expect(braveCompletion.expectedCount).toBe(20);
    expect(braveCompletion.missing).toEqual(QUERIES_V1.map((query) => query.id));
    const braveEligibility = report.eligibility.find((entry) => entry.provider === "brave")!;
    expect(braveEligibility.eligible).toBe(false);
    const braveRaw = report.raw.find((entry) => entry.provider === "brave")!;
    expect(braveRaw.completed).toBe(false);
    expect(braveRaw.runsCompleted).toBe(0);
    // tavily is complete and eligible
    expect(report.completions.find((completion) => completion.provider === "tavily")!.completed).toBe(true);
    expect(report.hardGates.fewerThanTwoCompleted).toBe(true);
  });

  it("records the native-currency pricing evidence (no keys) in every checkpoint", async () => {
    const checkpoints: BenchmarkReport[] = [];
    const report = await runBenchmark(harnessDeps({ writer: (entry) => checkpoints.push(entry) }));
    expect(report.pricing.brave).toEqual(USD_TAVILY);
    expect(report.pricing.tavily!.currency).toBe("CNY");
    expect(report.pricing.tavily!.amountPerRequest).toBe(0.036);
    // scoring costUsd derives from amountPerRequest x usdPerCurrencyUnit
    const tavilyRuns = report.runs.filter((run) => run.provider === "tavily");
    expect(tavilyRuns.length).toBeGreaterThan(0);
    expect(tavilyRuns[0]!.costUsd).toBeCloseTo(0.036 * 0.14, 6);
    expect(JSON.stringify(checkpoints[0])).not.toContain("API_KEY");
    expect(JSON.stringify(report)).not.toContain("API_KEY");
  });
});
