import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import {
  LIVE_PROVIDER_ENDPOINTS,
  LIVE_PROVIDER_FACTORIES,
  resolveLiveProviderSetup,
} from "./live-provider-assembly.js";
import { acceptLiveProviderResponse } from "./provider-live-acceptance.js";

/**
 * OPT-IN live URL-bearing compatibility smoke. resolveLiveProviderSetup runs
 * at module setup — BEFORE any ProviderHttpClient is constructed or any test
 * body runs — validating the exact five-provider selection, all five keys and
 * the exact five native-currency price records. Probes are built ONLY from
 * SETUP.providers, SETUP.tokens and the shared factory/endpoint maps; no local
 * provider literals exist here. After each probe, acceptLiveProviderResponse
 * (offline-tested) requires the expected provider id and at least one clickable
 * http(s) result so a green run proves URL-bearing compatibility — never just
 * "provider id matched with an empty result list". Responses are never printed
 * or persisted.
 */
const SETUP = resolveLiveProviderSetup(process.env as Record<string, string | undefined>);

describe("provider live URL-bearing compatibility (opt-in)", () => {
  for (const id of SETUP.providers) {
    it(`${id}: one query returns the provider id with at least one clickable http(s) result`, async () => {
      const client = new ProviderHttpClient({
        transport: createNodeProviderTransport(),
        endpoint: LIVE_PROVIDER_ENDPOINTS[id],
        totalTimeoutMs: 15_000,
      });
      const provider = LIVE_PROVIDER_FACTORIES[id](client, SETUP.tokens[id]);
      const response = await provider.search(
        { query: "humanoid robot companies official website", maxResults: 5 },
        new AbortController().signal,
      );
      acceptLiveProviderResponse(id, response);
      expect(response.provider).toBe(id);
      expect(response.results.length).toBeGreaterThan(0);
    });
  }
});
