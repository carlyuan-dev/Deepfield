import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BENCHMARK_PLAN,
  LIVE_BENCHMARK_OVERALL_TIMEOUT_MS,
  LIVE_BENCHMARK_VITEST_TIMEOUT_MS,
  assertBenchmarkPlanFacts,
  createBenchmarkDeadline,
  validateLiveBenchmarkPlan,
  type LiveBenchmarkPlan,
  type ScheduledHandle,
} from "./benchmark-live-plan.js";
import { runBenchmark, type HarnessProvider, type LinkChecker } from "./run-benchmark.js";
import { QUERIES_V1 } from "./queries.js";
import type { NormalizedSearchResponse } from "../search-provider.js";
import { BENCHMARK_CANDIDATES_V1 } from "../providers/provider-catalog.js";

const CANONICAL = [...BENCHMARK_CANDIDATES_V1];

describe("live benchmark plan (focused revision)", () => {
  it("is frozen with the approved four-provider facts", () => {
    expect(Object.isFrozen(BENCHMARK_PLAN)).toBe(true);
    expect(Object.isFrozen(BENCHMARK_PLAN.providers)).toBe(true);
    expect([...BENCHMARK_PLAN.providers]).toEqual(CANONICAL);
    expect(BENCHMARK_PLAN.queryCount).toBe(10);
    expect(QUERIES_V1.length).toBe(10);
    expect(BENCHMARK_PLAN.runsPerQuery).toBe(1);
    expect(BENCHMARK_PLAN.maxResults).toBe(20);
    expect(BENCHMARK_PLAN.expectedMeasurements).toBe(40);
    expect(BENCHMARK_PLAN.automaticProviderRetries).toBe(0);
    expect(validateLiveBenchmarkPlan()).toBeUndefined();
  });

  it("fails closed with a fixed sanitized error on any drift", () => {
    const good = { ...BENCHMARK_PLAN };
    const drifts: Array<Partial<LiveBenchmarkPlan>> = [
      { providers: Object.freeze(["tavily", "serper"]) }, // set drift
      { providers: Object.freeze([...CANONICAL, "extra" as never]) }, // count drift
      { queryCount: 9 },
      { runsPerQuery: 2 },
      { maxResults: 10 },
      { expectedMeasurements: 80 },
      { automaticProviderRetries: 1 },
    ];
    for (const drift of drifts) {
      expect(() => assertBenchmarkPlanFacts({ ...good, ...drift } as LiveBenchmarkPlan)).toThrow(/live benchmark plan validation failed/);
    }
    try {
      assertBenchmarkPlanFacts({ ...good, queryCount: 3 } as LiveBenchmarkPlan);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/live benchmark plan validation failed/);
      expect(String(error)).not.toContain("人形");
      expect(String(error)).not.toContain("API_KEY");
    }
  });

  it("keeps the overall application deadline strictly below the vitest per-test deadline", () => {
    expect(LIVE_BENCHMARK_OVERALL_TIMEOUT_MS).toBe(60 * 60_000);
    expect(LIVE_BENCHMARK_VITEST_TIMEOUT_MS).toBeGreaterThan(LIVE_BENCHMARK_OVERALL_TIMEOUT_MS);
    expect(LIVE_BENCHMARK_VITEST_TIMEOUT_MS - LIVE_BENCHMARK_OVERALL_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("cleans up the timer on success, failure and cancel paths", async () => {
    const scheduled: ScheduledHandle[] = [];
    const fired: Array<() => void> = [];
    const fake = {
      schedule: (fn: () => void, _ms: number): ScheduledHandle => {
        const handle: ScheduledHandle = { cleared: false };
        scheduled.push(handle);
        fired.push(fn);
        return handle;
      },
      clear: (handle: ScheduledHandle) => {
        handle.cleared = true;
      },
    };
    // cancel-before-fire: dispose clears without aborting
    const deadline = createBenchmarkDeadline(1_000, fake);
    expect(scheduled).toHaveLength(1);
    deadline.dispose();
    expect(scheduled[0]!.cleared).toBe(true);
    expect(deadline.controller.signal.aborted).toBe(false);
    // fire path: timer aborts the controller, dispose afterwards is idempotent
    const deadline2 = createBenchmarkDeadline(1_000, fake);
    fired[1]!();
    expect(deadline2.controller.signal.aborted).toBe(true);
    deadline2.dispose();
    deadline2.dispose();
    expect(scheduled[1]!.cleared).toBe(true);
  });

  it("propagates a real overall deadline into the harness so it stops without completing", async () => {
    const perSearchMs = 80; // far beyond the deadline below
    const calls: string[] = [];
    const slowProvider = (id: "baidu" | "metaso"): HarnessProvider => ({
      id,
      endpoint: `https://${id}.example/search`,
      async search(query, _max, signal): Promise<NormalizedSearchResponse> {
        calls.push(`${id}:${query}`);
        await new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("unreachable")), perSearchMs);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        throw new Error("unreachable");
      },
    });
    const linkChecker: LinkChecker = {
      async check() {
        throw new Error("must not run");
      },
    };
    const writers: number[] = [];
    const deadline = createBenchmarkDeadline(25);
    const report = await runBenchmark({
      providers: [slowProvider("baidu"), slowProvider("metaso")],
      runsPerQuery: 1,
      maxResults: 20,
      linkChecker,
      pricing: { baidu: usdPrice(), metaso: usdPrice() },
      writer: () => {
        writers.push(1);
      },
      signal: deadline.controller.signal,
    });
    deadline.dispose();
    expect(report.benchmarkComplete).toBe(false);
    expect(report.expectedMeasurements).toBe(20); // 2 providers x 10 queries x 1 run
    expect(report.attemptedMeasurements).toBeLessThan(20);
    // no provider search or link check runs after the deadline fired
    expect(calls.length).toBeLessThan(20);
    // a final incomplete checkpoint was written
    expect(writers.length).toBeGreaterThan(0);
  });

  it("keeps the live source consuming only the locked plan (no 2-run magic)", () => {
    const source = readFileSync(join(import.meta.dirname, "search-benchmark.live.test.ts"), "utf8");
    expect(source).toContain("BENCHMARK_PLAN");
    expect(source).not.toMatch(/runsPerQuery:\s*2/);
    expect(source).not.toMatch(/\*\s*10\s*\*\s*2/);
    expect(source).not.toContain("* 10 * 2");
    expect(source).toContain("expectedMeasurements).toBe(");
  });
});

function usdPrice() {
  return {
    amountPerRequest: 0.01,
    currency: "USD" as const,
    usdPerCurrencyUnit: 1,
    priceSourceUrl: "https://example.com/pricing",
    priceObservedOn: "2026-09-01",
  };
}
