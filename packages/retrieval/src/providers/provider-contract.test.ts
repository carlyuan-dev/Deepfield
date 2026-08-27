import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProviderHttpClient,
  parseRetryAfter,
  type ProviderEndpoint,
  type ProviderTransport,
  type ProviderTransportResponse,
} from "../provider-http-client.js";
import { SearchProviderError } from "../search-provider.js";
import { createBraveProvider } from "./brave.js";
import { createTavilyProvider } from "./tavily.js";
import { createSerperProvider } from "./serper.js";
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

function clientFor(transport: ProviderTransport): ProviderHttpClient {
  return new ProviderHttpClient({ transport });
}

const ENDPOINT: ProviderEndpoint = { origin: "https://api.search.brave.com", pathPrefix: "/res/v1/web/search" };
const REQUEST = { method: "GET" as const, path: "/res/v1/web/search?q=x&count=20", signal: new AbortController().signal };

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("provider http client (focused revision)", () => {
  it("rejects redirects, 401, 429 (with Retry-After bounds) and 5xx with stable codes", async () => {
    const client = clientFor(scriptedTransport([() => rawResponse(302, "", { location: "https://evil.example" })]).transport);
    await expect(client.request(ENDPOINT, REQUEST)).rejects.toMatchObject({ code: "redirect_blocked" });

    const client401 = clientFor(scriptedTransport([() => rawResponse(401, "unauthorized")]).transport);
    await expect(client401.request(ENDPOINT, REQUEST)).rejects.toMatchObject({ code: "unauthorized" });

    const client429 = clientFor(scriptedTransport([() => rawResponse(429, "slow down", { "retry-after": "5" })]).transport);
    const rateError = await errorOf(client429.request(ENDPOINT, REQUEST));
    expect(rateError).toMatchObject({ code: "rate_limited", retryAfterMs: 5000 });

    const client500 = clientFor(scriptedTransport([() => rawResponse(500, "boom")]).transport);
    await expect(client500.request(ENDPOINT, REQUEST)).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("parses Retry-After legal/illegal boundaries", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("abc")).toBeUndefined();
    expect(parseRetryAfter("-3")).toBeUndefined();
    expect(parseRetryAfter("999999")).toBeUndefined();
    expect(parseRetryAfter(["5", "6"])).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it("bounds response bytes during streaming and cancels on pre-abort", async () => {
    const client = clientFor(scriptedTransport([() => ({
      statusCode: 200,
      headers: {},
      body: Readable.from([Buffer.from("x".repeat(10_000))]),
      destroy() {},
    })]).transport);
    await expect(
      client.request(ENDPOINT, { ...REQUEST, maxResponseBytes: 100 }),
    ).rejects.toMatchObject({ code: "response_too_large" });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      client.request(ENDPOINT, { ...REQUEST, signal: preAborted.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("never leaks authorization or keys into errors", async () => {
    const client = clientFor(scriptedTransport([() => ({
      statusCode: 500,
      headers: {},
      body: Readable.from([Buffer.from('{"error":"sk-secret-key-value"}')]),
      destroy() {},
    })]).transport);
    const error = await errorOf(
      client.request(ENDPOINT, {
        ...REQUEST,
        headers: { "X-Subscription-Token": "sk-visible-token", authorization: "Bearer sk-visible-token" },
      }),
    );
    expect(String(error)).not.toContain("sk-secret-key-value");
    expect(String(error)).not.toContain("sk-visible-token");
    expect(String(error)).not.toContain("Bearer");
  });
});

describe("candidate provider adapters (focused revision)", () => {
  async function braveError(script: Array<() => ProviderTransportResponse>): Promise<SearchProviderError> {
    const { transport } = scriptedTransport(script);
    const provider = createBraveProvider({ client: clientFor(transport), token: "sk-test" });
    return (await errorOf(provider.search({ query: "人形机器人 公司", maxResults: 20 }, new AbortController().signal))) as SearchProviderError;
  }

  it("brave: success fixture, zero results and the request shape", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "brave-success.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = createBraveProvider({ client: clientFor(transport), token: "sk-test" });
    const response = await provider.search({ query: "人形机器人 公司", maxResults: 20 }, new AbortController().signal);
    expect(response.results).toHaveLength(2);
    expect(response.results[0]).toMatchObject({ title: "Official Site", url: "https://example.com", rank: 1, provider: "brave" });
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.path).toContain("count=20");
    expect(requests[0]!.headers["X-Subscription-Token"]).toBe("sk-test");

    const zero = JSON.parse(readFileSync(join(FIXTURES, "brave-zero.json"), "utf8"));
    const zeroProvider = createBraveProvider({ client: clientFor(scriptedTransport([() => jsonResponse(200, zero)]).transport), token: "sk-test" });
    const zeroResponse = await zeroProvider.search({ query: "x", maxResults: 20 }, new AbortController().signal);
    expect(zeroResponse.results).toHaveLength(0);
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
    const provider = createBraveProvider({ client: clientFor(transport), token: "sk-visible-token" });
    const error = (await errorOf(provider.search({ query: "x", maxResults: 20 }, new AbortController().signal))) as SearchProviderError;
    expect(String(error)).not.toContain("sk-visible-token");
    expect(String(error)).not.toContain("invalid api key");
  });

  it("tavily: success fixture with published_date and POST body shape", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "tavily-success.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = createTavilyProvider({ client: clientFor(transport), token: "sk-test" });
    const response = await provider.search({ query: "humanoid robot", maxResults: 20 }, new AbortController().signal);
    expect(response.results[0]).toMatchObject({ title: "Tavily Result", url: "https://tavily.example", rank: 1, date: "2026-08-20" });
    expect(requests[0]!.method).toBe("POST");
    expect(JSON.parse(requests[0]!.body ?? "{}")).toMatchObject({ api_key: "sk-test", query: "humanoid robot", max_results: 20 });
  });

  it("serper: success fixture with date and X-API-KEY header", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "serper-success.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = createSerperProvider({ client: clientFor(transport), token: "sk-test" });
    const response = await provider.search({ query: "actuator supplier", maxResults: 20 }, new AbortController().signal);
    expect(response.results[0]).toMatchObject({ title: "Serper Result", url: "https://serper.example", rank: 1, date: "2026-08-22" });
    expect(requests[0]!.headers["X-API-KEY"]).toBe("sk-test");
  });
});

describe("search_web definition (focused revision)", () => {
  it("maps provider errors to stable Tool codes and never leaks payloads", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "brave-secret-error.json"), "utf8"));
    const { transport } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = createBraveProvider({ client: clientFor(transport), token: "sk-visible-token" });
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
    const provider = createBraveProvider({ client: clientFor(transport), token: "sk-test" });
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
});
