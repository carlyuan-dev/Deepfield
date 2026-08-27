import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import { createBraveProvider, ENDPOINT as BRAVE_ENDPOINT } from "../providers/brave.js";
import { createTavilyProvider, ENDPOINT as TAVILY_ENDPOINT } from "../providers/tavily.js";
import { createSerperProvider, ENDPOINT as SERPER_ENDPOINT } from "../providers/serper.js";
import { resolveLiveRun, type LiveProviderId } from "../providers/live-config.js";
import { runBenchmark, type HarnessProvider } from "./run-benchmark.js";
import { createHttpLinkChecker } from "./link-checker.js";
import { writeBenchmarkReport } from "./report.js";
import { SafeHttpTransport } from "../http-transport.js";
import { createNodeHttpAdapter } from "../node-http-adapter.js";
import { join } from "node:path";

/**
 * OPT-IN live benchmark. The selected provider set and every required key are
 * resolved at module load and the per-request pricing config is parsed and
 * validated BEFORE any network request or report write; anything missing or
 * illegal fails the whole suite (exit != 0) and no benchmark-results/ file is
 * created. The loop/checkpoint state machine is the offline-tested
 * runBenchmark harness.
 */
const RUN = resolveLiveRun(process.env as Record<string, string | undefined>);

function parsePricing(): Record<string, number> {
  const raw = process.env.DEEPFIELD_SEARCH_PRICING;
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error("DEEPFIELD_SEARCH_PRICING is required (JSON per-request USD, e.g. {\"brave\":0.01,\"tavily\":0.02})");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid DEEPFIELD_SEARCH_PRICING: not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid DEEPFIELD_SEARCH_PRICING: must be an object");
  }
  const pricing: Record<string, number> = {};
  for (const [provider, price] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      throw new Error(`invalid DEEPFIELD_SEARCH_PRICING for ${provider}: must be a finite non-negative number`);
    }
    pricing[provider] = price;
  }
  return pricing;
}

const PRICING_USD = parsePricing();
const PRICING_NOTE = "Task-9-confirmed per-request USD pricing; version v1";

const ENDPOINTS: Record<LiveProviderId, { origin: string; pathPrefix: string }> = {
  brave: BRAVE_ENDPOINT,
  tavily: TAVILY_ENDPOINT,
  serper: SERPER_ENDPOINT,
};

const FACTORIES: Record<LiveProviderId, (client: ProviderHttpClient, token: string) => { search(req: { query: string; maxResults: number }, signal: AbortSignal): Promise<{ provider: string; results: { title: string; url: string; snippet: string; rank: number; provider: string }[] }> }> = {
  brave: (client, token) => createBraveProvider({ client, token }),
  tavily: (client, token) => createTavilyProvider({ client, token }),
  serper: (client, token) => createSerperProvider({ client, token }),
};

function makeHarnessProviders(): HarnessProvider[] {
  return RUN.providers.map((id) => {
    const client = new ProviderHttpClient({
      transport: createNodeProviderTransport(),
      endpoint: ENDPOINTS[id],
      totalTimeoutMs: 20_000,
    });
    const provider = FACTORIES[id](client, RUN.tokens[id]);
    return {
      id,
      endpoint: `${ENDPOINTS[id].origin}${ENDPOINTS[id].pathPrefix}`,
      search: (query, maxResults, signal) => provider.search({ query, maxResults }, signal),
    };
  });
}

describe("search benchmark live (opt-in)", () => {
  it("runs the frozen query set through the offline-tested harness and writes a complete report", async () => {
    // live link checking reuses the accepted SafeHttpTransport chain
    const transport = new SafeHttpTransport({
      policy: new (await import("../url-policy.js")).UrlPolicy(),
      adapter: createNodeHttpAdapter(),
      maxBodyBytes: 1024,
    });
    const report = await runBenchmark({
      providers: makeHarnessProviders(),
      runsPerQuery: 2,
      maxResults: 20,
      linkChecker: createHttpLinkChecker(transport),
      pricingUsd: PRICING_USD,
      pricingNote: PRICING_NOTE,
      writer: (entry) => {
        writeBenchmarkReport(join(process.cwd(), "benchmark-results"), entry);
      },
    });
    expect(report.benchmarkComplete).toBe(true);
    expect(report.attemptedMeasurements).toBe(report.expectedMeasurements);
    expect(report.expectedMeasurements).toBe(RUN.providers.length * 10 * 2);
    expect(JSON.stringify(report)).not.toContain("API_KEY");
  });
});
