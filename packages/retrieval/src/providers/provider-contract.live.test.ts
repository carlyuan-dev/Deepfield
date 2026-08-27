import { describe, expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-http-client.js";
import { createBraveProvider } from "./brave.js";
import { createTavilyProvider } from "./tavily.js";
import { createSerperProvider } from "./serper.js";

/**
 * OPT-IN live compatibility smoke: only runs under vitest.live.config.ts and
 * only when the required environment keys are present. Missing keys FAIL
 * loudly (never silently skipped). Task 8 does not execute this suite.
 */
function requireKey(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required to run live provider tests`);
  }
  return value;
}

function makeClient(): ProviderHttpClient {
  return new ProviderHttpClient({ transport: createNodeProviderTransport(), totalTimeoutMs: 15_000 });
}

describe("provider live compatibility (opt-in)", () => {
  it("brave: one query against the official endpoint records status and schema compatibility", async () => {
    const provider = createBraveProvider({ client: makeClient(), token: requireKey("BRAVE_SEARCH_API_KEY") });
    const response = await provider.search({ query: "humanoid robot companies official website", maxResults: 5 }, new AbortController().signal);
    expect(response.provider).toBe("brave");
    expect(Array.isArray(response.results)).toBe(true);
  });

  it("tavily: one query against the official endpoint records status and schema compatibility", async () => {
    const provider = createTavilyProvider({ client: makeClient(), token: requireKey("TAVILY_API_KEY") });
    const response = await provider.search({ query: "humanoid robot actuator supplier", maxResults: 5 }, new AbortController().signal);
    expect(response.provider).toBe("tavily");
    expect(Array.isArray(response.results)).toBe(true);
  });

  it("serper: one query against the official endpoint records status and schema compatibility", async () => {
    const provider = createSerperProvider({ client: makeClient(), token: requireKey("SERPER_API_KEY") });
    const response = await provider.search({ query: "humanoid robot startup company", maxResults: 5 }, new AbortController().signal);
    expect(response.provider).toBe("serper");
    expect(Array.isArray(response.results)).toBe(true);
  });
});
