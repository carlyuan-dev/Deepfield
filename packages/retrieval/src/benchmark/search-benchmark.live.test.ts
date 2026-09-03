import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import { createBraveProvider, ENDPOINT as BRAVE_ENDPOINT } from "../providers/brave.js";
import { createTavilyProvider, ENDPOINT as TAVILY_ENDPOINT } from "../providers/tavily.js";
import { createSerperProvider, ENDPOINT as SERPER_ENDPOINT } from "../providers/serper.js";
import { resolveLiveRun } from "../providers/live-config.js";
import {
  requireBenchmarkCandidateAssembly,
  type LiveProviderId,
  type SupportedProviderId,
} from "../providers/provider-catalog.js";
import { runBenchmark, type HarnessProvider } from "./run-benchmark.js";
import { createHttpLinkChecker } from "./link-checker.js";
import { parseProviderPricingJson, type ProviderPrice } from "./pricing.js";
import { writeBenchmarkReport } from "./report.js";
import { SafeHttpTransport } from "../http-transport.js";
import { createNodeHttpAdapter } from "../node-http-adapter.js";
import { join } from "node:path";

/**
 * OPT-IN live benchmark. Phase 1 has only the legacy brave/tavily/serper
 * endpoint/factory literals, so requireBenchmarkCandidateAssembly fails closed
 * with the stable incomplete-assembly error BEFORE any key resolution,
 * transport construction, pricing parse, writer call or test body — the
 * three-provider live path can never silently execute and no benchmark-results
 * file is written.
 */
const ENDPOINTS: Partial<Record<SupportedProviderId, { origin: string; pathPrefix: string }>> = {
  brave: BRAVE_ENDPOINT,
  tavily: TAVILY_ENDPOINT,
  serper: SERPER_ENDPOINT,
};

type ProviderLike = { search(req: { query: string; maxResults: number }, signal: AbortSignal): Promise<{ provider: string; results: { title: string; url: string; snippet: string; rank: number; provider: string }[] }> };
type Factory = (client: ProviderHttpClient, token: string) => ProviderLike;

const FACTORIES: Partial<Record<SupportedProviderId, Factory>> = {
  brave: (client, token) => createBraveProvider({ client, token }),
  tavily: (client, token) => createTavilyProvider({ client, token }),
  serper: (client, token) => createSerperProvider({ client, token }),
};

// Fail-closed Phase 1 boundary: throws before any I/O while baidu/zhipu/metaso
// are missing (P2-T8A Phase 2 search-benchmark assembly is incomplete:
// baidu,zhipu,metaso). The complete record is the only map indexed below.
const ENDPOINT_ASSEMBLY = requireBenchmarkCandidateAssembly("search-benchmark endpoints", ENDPOINTS);
const FACTORY_ASSEMBLY = requireBenchmarkCandidateAssembly("search-benchmark", FACTORIES);

const RUN = resolveLiveRun(process.env as Record<string, string | undefined>);

/** DEEPFIELD_SEARCH_PRICING carries native-currency price evidence (never keys). */
function loadPricing(): Readonly<Record<string, ProviderPrice>> {
  return parseProviderPricingJson(process.env.DEEPFIELD_SEARCH_PRICING, RUN.providers);
}

const PRICING = loadPricing();

function makeHarnessProviders(): HarnessProvider[] {
  return RUN.providers.map((id: LiveProviderId) => {
    const client = new ProviderHttpClient({
      transport: createNodeProviderTransport(),
      endpoint: ENDPOINT_ASSEMBLY[id],
      totalTimeoutMs: 20_000,
    });
    const provider = FACTORY_ASSEMBLY[id](client, RUN.tokens[id]);
    return {
      id,
      endpoint: `${ENDPOINT_ASSEMBLY[id].origin}${ENDPOINT_ASSEMBLY[id].pathPrefix}`,
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
      pricing: PRICING,
      writer: (entry) => {
        writeBenchmarkReport(join(process.cwd(), "benchmark-results"), entry);
      },
    });
    expect(report.benchmarkComplete).toBe(true);
    expect(report.attemptedMeasurements).toBe(report.expectedMeasurements);
    expect(report.expectedMeasurements).toBe(RUN.providers.length * 10 * 2);
    expect(JSON.stringify(report)).not.toContain("API_KEY");
    expect(JSON.stringify(report.pricing)).not.toContain("API_KEY");
  });
});
