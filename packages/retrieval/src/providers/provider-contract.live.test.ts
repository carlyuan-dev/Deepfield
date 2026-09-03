import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import { createBraveProvider, ENDPOINT as BRAVE_ENDPOINT } from "./brave.js";
import { createTavilyProvider, ENDPOINT as TAVILY_ENDPOINT } from "./tavily.js";
import { createSerperProvider, ENDPOINT as SERPER_ENDPOINT } from "./serper.js";
import {
  requireBenchmarkCandidateAssembly,
  type LiveProviderId,
  type SupportedProviderId,
} from "./provider-catalog.js";
import type { SearchProvider } from "../search-provider.js";

/**
 * OPT-IN live compatibility smoke. Phase 1 has only the legacy brave/tavily/
 * serper factories, so requireBenchmarkCandidateAssembly fails closed with the
 * stable incomplete-assembly error BEFORE any key resolution, transport
 * construction or test body — the three-provider live path can never silently
 * execute.
 */
type Factory = (client: ProviderHttpClient, token: string) => SearchProvider;

const ENDPOINTS: Partial<Record<SupportedProviderId, { origin: string; pathPrefix: string }>> = {
  brave: BRAVE_ENDPOINT,
  tavily: TAVILY_ENDPOINT,
  serper: SERPER_ENDPOINT,
};

const FACTORIES: Partial<Record<SupportedProviderId, Factory>> = {
  brave: (client, token) => createBraveProvider({ client, token }),
  tavily: (client, token) => createTavilyProvider({ client, token }),
  serper: (client, token) => createSerperProvider({ client, token }),
};

// Fail-closed Phase 1 boundary: throws before any I/O while baidu/zhipu/metaso
// factories are missing (P2-T8A Phase 2 provider-contract assembly is
// incomplete: baidu,zhipu,metaso).
const ENDPOINT_ASSEMBLY = requireBenchmarkCandidateAssembly("provider-contract endpoints", ENDPOINTS);
const FACTORY_ASSEMBLY = requireBenchmarkCandidateAssembly("provider-contract", FACTORIES);

describe("provider live compatibility (opt-in)", () => {
  for (const id of Object.keys(FACTORY_ASSEMBLY) as LiveProviderId[]) {
    it(`${id}: one query against the official endpoint records status and schema compatibility`, async () => {
      const client = new ProviderHttpClient({
        transport: createNodeProviderTransport(),
        endpoint: ENDPOINT_ASSEMBLY[id],
        totalTimeoutMs: 15_000,
      });
      const provider = FACTORY_ASSEMBLY[id](client, "placeholder-not-read");
      const response = await provider.search(
        { query: "humanoid robot companies official website", maxResults: 5 },
        new AbortController().signal,
      );
      expect(response.provider).toBe(id);
      expect(Array.isArray(response.results)).toBe(true);
    });
  }
});
