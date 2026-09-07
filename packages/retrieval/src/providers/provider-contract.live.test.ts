import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import {
  LIVE_PROVIDER_ENDPOINTS,
  LIVE_PROVIDER_FACTORIES,
  resolveLiveProviderSetup,
} from "./live-provider-assembly.js";
import { acceptLiveProviderResponse } from "./provider-live-acceptance.js";
import {
  LIVE_CONTRACT_HTTP_TIMEOUT_MS,
  LIVE_CONTRACT_TEST_TIMEOUT_MS,
} from "./live-contract-timeouts.js";
import { resolveContractScope } from "./provider-contract-scope.js";

/**
 * OPT-IN live URL-bearing compatibility smoke. resolveLiveProviderSetup runs
 * at module setup — BEFORE any ProviderHttpClient is constructed or any test
 * body runs — validating the exact four-provider selection, all four keys and
 * the exact four native-currency price records. The fixed scope (all four by
 * default; ONLY tavily+serper when the launcher exports the exact "overseas"
 * value) is resolved AFTER that full validation, and the probe loop iterates
 * exactly the scope — so at most the scoped providers are ever constructed or
 * called. Probes are built ONLY from the shared factory/endpoint maps; after
 * each probe acceptLiveProviderResponse requires the expected provider id and
 * at least one clickable http(s) result. Responses are never printed or
 * persisted.
 */
const SETUP = resolveLiveProviderSetup(process.env as Record<string, string | undefined>);
const SCOPE_PROVIDERS = resolveContractScope(process.env as Record<string, string | undefined>);

describe("provider live URL-bearing compatibility (opt-in)", () => {
  for (const id of SCOPE_PROVIDERS) {
    // per-test deadline exceeds the 15s client budget (30s) so vitest never
    // cuts a probe short before the client finishes or cleans up
    it(
      `${id}: one query returns the provider id with at least one clickable http(s) result`,
      async () => {
        const client = new ProviderHttpClient({
          transport: createNodeProviderTransport(),
          endpoint: LIVE_PROVIDER_ENDPOINTS[id],
          totalTimeoutMs: LIVE_CONTRACT_HTTP_TIMEOUT_MS,
        });
        const provider = LIVE_PROVIDER_FACTORIES[id](client, SETUP.tokens[id]);
        const response = await provider.search(
          { query: "humanoid robot companies official website", maxResults: 5 },
          new AbortController().signal,
        );
        acceptLiveProviderResponse(id, response);
        expect(response.provider).toBe(id);
        expect(response.results.length).toBeGreaterThan(0);
      },
      LIVE_CONTRACT_TEST_TIMEOUT_MS,
    );
  }
});
