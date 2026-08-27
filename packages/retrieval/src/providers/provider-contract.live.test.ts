import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import { createBraveProvider, ENDPOINT as BRAVE_ENDPOINT } from "./brave.js";
import { createTavilyProvider, ENDPOINT as TAVILY_ENDPOINT } from "./tavily.js";
import { createSerperProvider, ENDPOINT as SERPER_ENDPOINT } from "./serper.js";
import { requireProviderKey } from "./live-keys.js";

/**
 * OPT-IN live compatibility smoke: only runs under vitest.live.config.ts and
 * only when the required environment keys are present. Missing keys FAIL
 * loudly (never silently skipped). Task 8 does not execute this suite.
 */
function makeClient(endpoint: import("../provider-http-client.js").ProviderEndpoint): ProviderHttpClient {
  return new ProviderHttpClient({ transport: createNodeProviderTransport(), endpoint, totalTimeoutMs: 15_000 });
}

describe("provider live compatibility (opt-in)", () => {
  it("brave: one query against the official endpoint records status and schema compatibility", async () => {
    const provider = createBraveProvider({ client: makeClient(BRAVE_ENDPOINT), token: requireProviderKey("brave") });
    const response = await provider.search({ query: "humanoid robot companies official website", maxResults: 5 }, new AbortController().signal);
    expect(response.provider).toBe("brave");
    expect(Array.isArray(response.results)).toBe(true);
  });

  it("tavily: one query against the official endpoint records status and schema compatibility", async () => {
    const provider = createTavilyProvider({ client: makeClient(TAVILY_ENDPOINT), token: requireProviderKey("tavily") });
    const response = await provider.search({ query: "humanoid robot actuator supplier", maxResults: 5 }, new AbortController().signal);
    expect(response.provider).toBe("tavily");
    expect(Array.isArray(response.results)).toBe(true);
  });

  it("serper: one query against the official endpoint records status and schema compatibility", async () => {
    const provider = createSerperProvider({ client: makeClient(SERPER_ENDPOINT), token: requireProviderKey("serper") });
    const response = await provider.search({ query: "humanoid robot startup company", maxResults: 5 }, new AbortController().signal);
    expect(response.provider).toBe("serper");
    expect(Array.isArray(response.results)).toBe(true);
  });
});
