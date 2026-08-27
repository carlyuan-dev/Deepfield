import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import { createBraveProvider, ENDPOINT as BRAVE_ENDPOINT } from "./brave.js";
import { createTavilyProvider, ENDPOINT as TAVILY_ENDPOINT } from "./tavily.js";
import { createSerperProvider, ENDPOINT as SERPER_ENDPOINT } from "./serper.js";
import { resolveLiveRun, type LiveProviderId } from "./live-config.js";
import type { SearchProvider } from "../search-provider.js";

/**
 * OPT-IN live compatibility smoke: only runs under vitest.live.config.ts.
 * The selected provider set and every required key are resolved at module
 * load — ANY missing key or invalid selection fails the whole suite BEFORE
 * any network request or report write (never a silent skip).
 */
const RUN = resolveLiveRun(process.env as Record<string, string | undefined>);

const ENDPOINTS: Record<LiveProviderId, { origin: string; pathPrefix: string }> = {
  brave: BRAVE_ENDPOINT,
  tavily: TAVILY_ENDPOINT,
  serper: SERPER_ENDPOINT,
};

const FACTORIES: Record<LiveProviderId, (client: ProviderHttpClient, token: string) => SearchProvider> = {
  brave: (client, token) => createBraveProvider({ client, token }),
  tavily: (client, token) => createTavilyProvider({ client, token }),
  serper: (client, token) => createSerperProvider({ client, token }),
};

describe("provider live compatibility (opt-in)", () => {
  for (const id of RUN.providers) {
    it(`${id}: one query against the official endpoint records status and schema compatibility`, async () => {
      const client = new ProviderHttpClient({
        transport: createNodeProviderTransport(),
        endpoint: ENDPOINTS[id],
        totalTimeoutMs: 15_000,
      });
      const provider = FACTORIES[id](client, RUN.tokens[id]);
      const response = await provider.search(
        { query: "humanoid robot companies official website", maxResults: 5 },
        new AbortController().signal,
      );
      expect(response.provider).toBe(id);
      expect(Array.isArray(response.results)).toBe(true);
    });
  }
});
