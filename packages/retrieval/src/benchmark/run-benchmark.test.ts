import { describe, expect, it } from "vitest";
import { runBenchmark, BenchmarkInputError, type BenchmarkHarnessDeps, type HarnessProvider, type LinkChecker } from "./run-benchmark.js";
import type { BenchmarkReport } from "./report.js";
import type { NormalizedSearchResponse } from "../search-provider.js";
import { QUERIES_V1 } from "./queries.js";
import { REFERENCE_COMPANIES_V1 } from "./reference-companies.js";

function fakeProvider(id: "brave" | "tavily", opts: { failQueries?: Set<string>; urls?: () => string[] } = {}): HarnessProvider {
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
      const urls = opts.urls !== undefined ? opts.urls() : [`https://${id}.example/${encodeURIComponent(query)}`];
      const response: NormalizedSearchResponse = {
        provider: id,
        results: urls.map((url, index) => ({ title: `t${index}`, url, snippet: "s", rank: index + 1, provider: id })),
      };
      return response;
    },
  };
}

function fakeChecker(validRate = 1): LinkChecker {
  return {
    async check(urls) {
      const valid = Math.floor(urls.length * validRate);
      return { valid, total: urls.length };
    },
  };
}

function harnessDeps(overrides: Partial<BenchmarkHarnessDeps> = {}): BenchmarkHarnessDeps {
  return {
    providers: [fakeProvider("brave"), fakeProvider("tavily")],
    runsPerQuery: 2,
    maxResults: 20,
    linkChecker: fakeChecker(),
    pricingUsd: { brave: 0.01, tavily: 0.02 },
    pricingNote: "test pricing v1",
    writer: () => {},
    ...overrides,
  };
}

describe("benchmark harness state machine (focused revision)", () => {
  it("fixes expectedMeasurements up front (first checkpoint already shows the full expected count)", async () => {
    const checkpoints: BenchmarkReport[] = [];
    const report = await runBenchmark(harnessDeps({ writer: (entry) => checkpoints.push(entry) }));
    // 2 providers x 10 queries x 2 rounds = 40, fixed before any request
    expect(report.expectedMeasurements).toBe(40);
    expect(checkpoints[0]!.expectedMeasurements).toBe(40);
    expect(checkpoints[0]!.attemptedMeasurements).toBe(1);
    expect(checkpoints[0]!.successfulMeasurements).toBe(1);
    expect(checkpoints[0]!.benchmarkComplete).toBe(false);
    expect(report.benchmarkComplete).toBe(true);
    expect(report.attemptedMeasurements).toBe(40);
    expect(report.successfulMeasurements).toBe(40);
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
    // q1 fails in both providers x 2 rounds = 4 failures
    expect(report.attemptedMeasurements).toBe(40);
    expect(report.successfulMeasurements).toBe(36);
    expect(report.failures.length).toBe(4);
    // the failed q1 runs never became successful runs
    expect(report.runs.every((run) => run.queryId !== "q1" || run.results.length > 0)).toBe(true);
    // the interrupted-marker checkpoints are benchmarkComplete=false until the end
    const lastCheckpoint = checkpoints[checkpoints.length - 1]!;
    expect(lastCheckpoint.benchmarkComplete).toBe(true);
    expect(lastCheckpoint.successfulMeasurements).toBe(36);
  });

  it("keeps the last checkpoint on interrupt with benchmarkComplete=false", async () => {
    const controller = new AbortController();
    const checkpoints: BenchmarkReport[] = [];
    // abort after the first provider finishes (20 attempts)
    let count = 0;
    const runPromise = runBenchmark(harnessDeps({
      providers: [fakeProvider("brave"), fakeProvider("tavily")],
      signal: controller.signal,
      writer: (entry) => {
        checkpoints.push(entry);
        count += 1;
        if (count === 20) {
          controller.abort();
        }
      },
    }));
    const report = await runPromise;
    expect(report.benchmarkComplete).toBe(false);
    expect(report.attemptedMeasurements).toBe(20);
    expect(report.hardGatePassed).toBe(false);
    // the last written checkpoint reflects the interrupt
    const lastCheckpoint = checkpoints[checkpoints.length - 1]!;
    expect(lastCheckpoint.benchmarkComplete).toBe(false);
    expect(lastCheckpoint.attemptedMeasurements).toBe(20);
  });

  it("rejects illegal pricing and config before any measurement", async () => {
    await expect(
      runBenchmark(harnessDeps({ pricingUsd: { brave: -1, tavily: 0.02 } })),
    ).rejects.toThrow(BenchmarkInputError);
    await expect(
      runBenchmark(harnessDeps({ pricingUsd: { brave: Number.NaN, tavily: 0.02 } })),
    ).rejects.toThrow(BenchmarkInputError);
    await expect(
      runBenchmark(harnessDeps({ pricingUsd: { brave: 0.01 } })),
    ).rejects.toThrow(/pricing/);
    await expect(runBenchmark(harnessDeps({ runsPerQuery: 0 }))).rejects.toThrow(BenchmarkInputError);
    await expect(runBenchmark(harnessDeps({ providers: [fakeProvider("brave")] }))).rejects.toThrow(/at least two/);
  });

  it("rejects a link check whose total does not match the deduplicated URL set", async () => {
    const badChecker: LinkChecker = {
      async check(_urls) {
        return { valid: 1, total: 1 }; // wrong denominator for a 2-url set
      },
    };
    const report = await runBenchmark(harnessDeps({ linkChecker: badChecker, providers: [fakeProvider("brave", { urls: () => ["https://a.example/1", "https://a.example/2"] }), fakeProvider("tavily")] }));
    expect(report.failures.some((failure) => failure.includes("link check sample invalid"))).toBe(true);
    const braveEligibility = report.eligibility.find((entry) => entry.provider === "brave")!;
    expect(braveEligibility.eligible).toBe(false);
  });

  it("records the pricing config (no keys) in every checkpoint", async () => {
    const checkpoints: BenchmarkReport[] = [];
    const report = await runBenchmark(harnessDeps({ writer: (entry) => checkpoints.push(entry) }));
    expect(report.pricingUsd).toEqual({ brave: 0.01, tavily: 0.02 });
    expect(report.pricingNote).toBe("test pricing v1");
    expect(JSON.stringify(checkpoints[0])).not.toContain("API_KEY");
    expect(JSON.stringify(report)).not.toContain("API_KEY");
  });
});
