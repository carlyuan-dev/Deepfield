import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProviderHttpClient,
  type ProviderEndpoint,
  type ProviderTransport,
  type ProviderTransportResponse,
} from "../provider-http-client.js";
import { SearchProviderError, type SearchRequest } from "../search-provider.js";
import { createBraveProvider, ENDPOINT as BRAVE_ENDPOINT } from "./brave.js";
import { createTavilyProvider, ENDPOINT as TAVILY_ENDPOINT } from "./tavily.js";
import { createSerperProvider, ENDPOINT as SERPER_ENDPOINT } from "./serper.js";
import { createSearchWebDefinition } from "../search-tool.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

function jsonResponse(statusCode: number, body: unknown, headers: Record<string, string | string[] | undefined> = {}): ProviderTransportResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...headers },
    body: Readable.from([Buffer.from(JSON.stringify(body), "utf8")]),
    destroy() {},
  };
}

function rawResponse(statusCode: number, body: string, headers: Record<string, string | string[] | undefined> = {}): ProviderTransportResponse {
  return {
    statusCode,
    headers,
    body: Readable.from([Buffer.from(body, "utf8")]),
    destroy() {},
  };
}

function scriptedTransport(script: Array<() => ProviderTransportResponse>) {
  const requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: string }> = [];
  let index = 0;
  const transport: ProviderTransport = {
    async request(_endpoint, request) {
      requests.push({
        method: request.method,
        path: request.path,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
      });
      const next = script[index];
      index += 1;
      if (next === undefined) {
        throw new Error("no more scripted responses");
      }
      return next();
    },
  };
  return { transport, requests };
}

function clientFor(transport: ProviderTransport, endpoint: ProviderEndpoint = BRAVE_ENDPOINT): ProviderHttpClient {
  return new ProviderHttpClient({ transport, endpoint });
}

const REQUEST = { method: "GET" as const, path: "/res/v1/web/search?q=x&count=20", signal: new AbortController().signal };

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("candidate provider adapters (focused revision)", () => {
  async function braveError(script: Array<() => ProviderTransportResponse>): Promise<SearchProviderError> {
    const { transport } = scriptedTransport(script);
    const provider = createBraveProvider({ client: clientFor(transport, BRAVE_ENDPOINT), token: "sk-test" });
    return (await errorOf(provider.search({ query: "人形机器人 公司", maxResults: 20 }, new AbortController().signal))) as SearchProviderError;
  }

  it("brave: success fixture, zero results and the request shape", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "brave-success.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = createBraveProvider({ client: clientFor(transport, BRAVE_ENDPOINT), token: "sk-test" });
    const response = await provider.search({ query: "人形机器人 公司", maxResults: 20 }, new AbortController().signal);
    expect(response.results).toHaveLength(2);
    expect(response.results[0]).toMatchObject({ title: "Official Site", url: "https://example.com/", rank: 1, provider: "brave" });
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.path).toContain("count=20");
    expect(requests[0]!.headers["X-Subscription-Token"]).toBe("sk-test");

    const zero = JSON.parse(readFileSync(join(FIXTURES, "brave-zero.json"), "utf8"));
    const zeroProvider = createBraveProvider({ client: clientFor(scriptedTransport([() => jsonResponse(200, zero)]).transport, BRAVE_ENDPOINT), token: "sk-test" });
    const zeroResponse = await zeroProvider.search({ query: "x", maxResults: 20 }, new AbortController().signal);
    expect(zeroResponse.results).toHaveLength(0);
  });

  it("brave: maps timeRange to freshness and enforces official query limits before the network", async () => {
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, { web: { results: [] } })]);
    const provider = createBraveProvider({ client: clientFor(transport, BRAVE_ENDPOINT), token: "sk-test" });
    await provider.search(
      { query: "x", maxResults: 5, timeRange: { from: "2026-03-01", to: "2026-03-31" } },
      new AbortController().signal,
    );
    expect(requests[0]!.path).toContain("freshness=2026-03-01to2026-03-31");

    // overlong/over-worded queries fail before any transport call
    const longQuery = "x".repeat(401);
    const longError = await errorOf(provider.search({ query: longQuery, maxResults: 5 }, new AbortController().signal));
    expect(longError).toMatchObject({ code: "invalid_request" });
    const manyWords = Array.from({ length: 51 }, (_, i) => `w${i}`).join(" ");
    const wordError = await errorOf(provider.search({ query: manyWords, maxResults: 5 }, new AbortController().signal));
    expect(wordError).toMatchObject({ code: "invalid_request" });
    expect(requests).toHaveLength(1); // only the timeRange request reached the transport
  });

  it("rejects a client bound to a DIFFERENT endpoint before any secret or transport call", async () => {
    const attackerEndpoint: ProviderEndpoint = { origin: "https://attacker.example", pathPrefix: "/res/v1/web/search" };
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, { web: { results: [] } })]);
    const attackerClient = new ProviderHttpClient({ transport, endpoint: attackerEndpoint });
    expect(() => createBraveProvider({ client: attackerClient, token: "sk-attacker-token" })).toThrow(SearchProviderError);
    // the brave adapter must NOT have contacted the attacker origin
    expect(requests).toHaveLength(0);

    const { transport: transport2, requests: requests2 } = scriptedTransport([() => jsonResponse(200, { organic: [] })]);
    const mismatchedClient = new ProviderHttpClient({ transport: transport2, endpoint: SERPER_ENDPOINT });
    expect(() => createBraveProvider({ client: mismatchedClient, token: "sk-x" })).toThrow(SearchProviderError);
    expect(requests2).toHaveLength(0);

    const { transport: transport3, requests: requests3 } = scriptedTransport([() => jsonResponse(200, { results: [] })]);
    const braveClient = new ProviderHttpClient({ transport: transport3, endpoint: BRAVE_ENDPOINT });
    expect(() => createTavilyProvider({ client: braveClient, token: "sk-x" })).toThrow(SearchProviderError);
    expect(() => createSerperProvider({ client: braveClient, token: "sk-x" })).toThrow(SearchProviderError);
    expect(requests3).toHaveLength(0);
  });

  it("brave: 401, 429 with retry-after, 5xx, invalid JSON, missing results and dangerous URL", async () => {
    expect((await braveError([() => rawResponse(401, "nope")])).code).toBe("unauthorized");
    expect((await braveError([() => rawResponse(429, "slow", { "retry-after": "3" })])).code).toBe("rate_limited");
    expect((await braveError([() => rawResponse(503, "down")])).code).toBe("provider_unavailable");
    expect((await braveError([() => rawResponse(200, "{not-json")])).code).toBe("malformed_response");
    expect((await braveError([() => jsonResponse(200, { web: {} })])).code).toBe("malformed_response");
    expect(
      (await braveError([() => jsonResponse(200, { web: { results: [{ title: "x", url: "javascript:bad", description: "s" }] } })])).code,
    ).toBe("dangerous_url");
  });

  it("brave: secret-bearing provider error never leaks the key or raw body", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "brave-secret-error.json"), "utf8"));
    const { transport } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = createBraveProvider({ client: clientFor(transport, BRAVE_ENDPOINT), token: "sk-visible-token" });
    const error = (await errorOf(provider.search({ query: "x", maxResults: 20 }, new AbortController().signal))) as SearchProviderError;
    expect(String(error)).not.toContain("sk-visible-token");
    expect(String(error)).not.toContain("invalid api key");
  });

  it("tavily: success fixture with published_date and POST body shape incl. timeRange", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "tavily-success.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = createTavilyProvider({ client: clientFor(transport, TAVILY_ENDPOINT), token: "sk-test" });
    const response = await provider.search(
      { query: "humanoid robot", maxResults: 20, timeRange: { from: "2026-08-01", to: "2026-08-31" } },
      new AbortController().signal,
    );
    expect(response.results[0]).toMatchObject({ title: "Tavily Result", url: "https://tavily.example/", rank: 1, date: "2026-08-20" });
    expect(requests[0]!.method).toBe("POST");
    expect(JSON.parse(requests[0]!.body ?? "{}")).toMatchObject({
      api_key: "sk-test",
      query: "humanoid robot",
      max_results: 20,
      start_date: "2026-08-01",
      end_date: "2026-08-31",
    });
  });

  it("serper: success fixture with date, X-API-KEY header and explicit timeRange rejection", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "serper-success.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = createSerperProvider({ client: clientFor(transport, SERPER_ENDPOINT), token: "sk-test" });
    const response = await provider.search({ query: "actuator supplier", maxResults: 20 }, new AbortController().signal);
    expect(response.results[0]).toMatchObject({ title: "Serper Result", url: "https://serper.example/", rank: 1, date: "2026-08-22" });
    expect(requests[0]!.headers["X-API-KEY"]).toBe("sk-test");

    // capability declared false: timeRange is rejected up front, never silently ignored
    expect(provider.capabilities).toEqual({ timeRange: false });
    const rangeError = await errorOf(
      provider.search({ query: "x", maxResults: 5, timeRange: { from: "2026-03-01", to: "2026-03-31" } }, new AbortController().signal),
    );
    expect(rangeError).toMatchObject({ code: "invalid_request" });
    expect(requests).toHaveLength(1); // the timeRange request never reached the transport
  });

  it("adapters reject invalid requests before the network", async () => {
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, { organic: [] })]);
    const provider = createSerperProvider({ client: clientFor(transport, SERPER_ENDPOINT), token: "sk-test" });
    const badRange = await errorOf(
      provider.search({ query: "x", maxResults: 5, timeRange: { from: "2026-02-30", to: "2026-03-01" } }, new AbortController().signal),
    );
    expect(badRange).toMatchObject({ code: "invalid_request" });
    const badMax = await errorOf(provider.search({ query: "x", maxResults: 21 }, new AbortController().signal));
    expect(badMax).toMatchObject({ code: "invalid_request" });
    expect(requests).toHaveLength(0);
  });
});

describe("web_search definition (focused revision)", () => {
  it("maps provider errors to stable Tool codes and never leaks payloads", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "brave-secret-error.json"), "utf8"));
    const { transport } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = createBraveProvider({ client: clientFor(transport, BRAVE_ENDPOINT), token: "sk-visible-token" });
    const definition = createSearchWebDefinition(provider);
    const error = await errorOf(
      definition.execute({ query: "x", maxResults: 5 }, { traceId: "t", actor: "main_agent" }, new AbortController().signal, () => {}),
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("sk-visible-token");
    expect(String(error)).not.toContain("invalid api key");
  });

  it("returns the normalized output through the definition", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "brave-success.json"), "utf8"));
    const { transport } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = createBraveProvider({ client: clientFor(transport, BRAVE_ENDPOINT), token: "sk-test" });
    const definition = createSearchWebDefinition(provider);
    const output = await definition.execute(
      { query: "人形机器人 公司", maxResults: 2 },
      { traceId: "t", actor: "main_agent" },
      new AbortController().signal,
      () => {},
    );
    expect(output.results).toHaveLength(2);
    expect(output.results[0]).toMatchObject({ rank: 1, provider: "brave" });
    expect(JSON.stringify(output)).not.toContain("sk-test");
  });

  it("fails closed on illegal timeRange and unsupported capability at the tool boundary", async () => {
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, { organic: [] })]);
    const serper = createSerperProvider({ client: clientFor(transport, SERPER_ENDPOINT), token: "sk-test" });
    const definition = createSearchWebDefinition(serper);
    const badDates = await errorOf(
      definition.execute(
        { query: "x", maxResults: 5, timeRange: { from: "2026-02-30", to: "2026-03-01" } },
        { traceId: "t", actor: "main_agent" },
        new AbortController().signal,
        () => {},
      ),
    );
    expect(badDates).toMatchObject({ code: "invalid_input" });
    const reversed = await errorOf(
      definition.execute(
        { query: "x", maxResults: 5, timeRange: { from: "2026-03-01", to: "2026-02-01" } },
        { traceId: "t", actor: "main_agent" },
        new AbortController().signal,
        () => {},
      ),
    );
    expect(reversed).toMatchObject({ code: "invalid_input" });
    const unsupported = await errorOf(
      definition.execute(
        { query: "x", maxResults: 5, timeRange: { from: "2026-03-01", to: "2026-03-31" } },
        { traceId: "t", actor: "main_agent" },
        new AbortController().signal,
        () => {},
      ),
    );
    expect(unsupported).toMatchObject({ code: "invalid_input" });
    expect(requests).toHaveLength(0); // nothing reached the transport
  });
});
