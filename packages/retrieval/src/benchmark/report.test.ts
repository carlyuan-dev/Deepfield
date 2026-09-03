import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBenchmarkReport, REPORT_FILENAME, type BenchmarkReport } from "./report.js";

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
