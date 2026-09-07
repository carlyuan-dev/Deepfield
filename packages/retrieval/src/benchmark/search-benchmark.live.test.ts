import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import {
  LIVE_PROVIDER_ENDPOINTS,
  LIVE_PROVIDER_FACTORIES,
  resolveLiveProviderSetup,
} from "../providers/live-provider-assembly.js";
import { runBenchmark, type HarnessProvider } from "./run-benchmark.js";
import { createHttpLinkChecker } from "./link-checker.js";
import { writeBenchmarkReport } from "./report.js";
import { SafeHttpTransport } from "../http-transport.js";
import { createNodeHttpAdapter } from "../node-http-adapter.js";
import { join } from "node:path";
import {
  BENCHMARK_PLAN,
  createBenchmarkDeadline,
  validateLiveBenchmarkPlan,
  LIVE_BENCHMARK_OVERALL_TIMEOUT_MS,
  LIVE_BENCHMARK_VITEST_TIMEOUT_MS,
} from "./benchmark-live-plan.js";

/**
 * OPT-IN live benchmark. validateLiveBenchmarkPlan() and
 * resolveLiveProviderSetup() run at module setup — the single pre-I/O
 * boundary — locking the approved four-provider / 10-query / 1-run / 40-call
 * plan and validating the exact four-provider selection, all four keys and the
 * exact four native-currency price records BEFORE any transport construction,
 * pricing parse or test body. Providers come only from SETUP.providers/tokens
 * plus the shared endpoint/factory maps; SETUP.pricing feeds the
 * offline-tested runBenchmark harness. One overall deadline AbortController
 * covers provider searches and destination link checks; the vitest per-test
 * deadline (61 min) is strictly above the app deadline (60 min) so the app
 * always stops itself with a recoverable incomplete report first.
 */
validateLiveBenchmarkPlan();
const SETUP = resolveLiveProviderSetup(process.env as Record<string, string | undefined>);

function makeHarnessProviders(): HarnessProvider[] {
  return SETUP.providers.map((id) => {
    const client = new ProviderHttpClient({
      transport: createNodeProviderTransport(),
      endpoint: LIVE_PROVIDER_ENDPOINTS[id],
      totalTimeoutMs: 20_000,
    });
    const provider = LIVE_PROVIDER_FACTORIES[id](client, SETUP.tokens[id]);
    return {
      id,
      endpoint: `${LIVE_PROVIDER_ENDPOINTS[id].origin}${LIVE_PROVIDER_ENDPOINTS[id].pathPrefix}`,
      search: (query, maxResults, signal) => provider.search({ query, maxResults }, signal),
    };
  });
}

describe("search benchmark live (opt-in)", () => {
  it("runs the locked four-provider plan (10 queries x 1 run = 40 calls) and writes a complete report", async () => {
    const deadline = createBenchmarkDeadline(LIVE_BENCHMARK_OVERALL_TIMEOUT_MS);
    let report;
    try {
      // live link checking reuses the accepted SafeHttpTransport chain
      const transport = new SafeHttpTransport({
        policy: new (await import("../url-policy.js")).UrlPolicy(),
        adapter: createNodeHttpAdapter(),
        maxBodyBytes: 1024,
      });
      report = await runBenchmark({
        providers: makeHarnessProviders(),
        runsPerQuery: BENCHMARK_PLAN.runsPerQuery,
        maxResults: BENCHMARK_PLAN.maxResults,
        linkChecker: createHttpLinkChecker(transport),
        pricing: SETUP.pricing,
        writer: (entry) => {
          writeBenchmarkReport(join(process.cwd(), "benchmark-results"), entry);
        },
        signal: deadline.controller.signal,
      });
    } finally {
      deadline.dispose(); // always clear the overall timer
    }
    expect(report!.benchmarkComplete).toBe(true);
    expect(report!.attemptedMeasurements).toBe(report!.expectedMeasurements);
    expect(report!.expectedMeasurements).toBe(BENCHMARK_PLAN.expectedMeasurements); // 40
    expect(JSON.stringify(report)).not.toContain("API_KEY");
    expect(JSON.stringify(report!.pricing)).not.toContain("API_KEY");
  }, LIVE_BENCHMARK_VITEST_TIMEOUT_MS);
});
