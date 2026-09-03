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
import { countUnicodeCodePoints, createZhipuProvider, ZHIPU_ENDPOINT } from "./zhipu.js";

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

function zhipuClient(transport: ProviderTransport): ProviderHttpClient {
  return new ProviderHttpClient({ transport, endpoint: ZHIPU_ENDPOINT });
}

function makeProvider(transport: ProviderTransport) {
  return createZhipuProvider({ client: zhipuClient(transport), token: "sk-z-test-token" });
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("zhipu web search adapter (focused revision)", () => {
  it("counts Unicode code points with Array.from semantics incl. astral chars", () => {
    expect(countUnicodeCodePoints("")).toBe(0);
    expect(countUnicodeCodePoints("humanoid robot companies official website")).toBe(41);
    expect(countUnicodeCodePoints("人".repeat(70))).toBe(70);
    expect(countUnicodeCodePoints("\u{1F600}".repeat(70))).toBe(70);
    expect(Array.from("\u{1F600}".repeat(70)).length).toBe(70);
    expect("\u{1F600}".repeat(70).length).toBe(140); // UTF-16 would double-count
    expect(countUnicodeCodePoints("A\u{1F600}人")).toBe(3);
  });

  it("accepts exactly 70 code points and rejects 71 before the transport", async () => {
    const zero = JSON.parse(readFileSync(join(FIXTURES, "zhipu-zero.json"), "utf8"));
    // a legal 70-code-point query reaches the transport exactly once
    const legal = scriptedTransport([() => jsonResponse(200, zero)]);
    const legalProvider = makeProvider(legal.transport);
    const legalResponse = await legalProvider.search({ query: "a".repeat(70), maxResults: 5 }, new AbortController().signal);
    expect(legalResponse.results).toHaveLength(0);
    expect(legal.requests).toHaveLength(1);

    const { transport, requests } = scriptedTransport([]);
    const provider = makeProvider(transport);
    const signal = new AbortController().signal;
    expect((await errorOf(provider.search({ query: "人".repeat(71), maxResults: 5 }, signal)))).toMatchObject({ code: "invalid_request" });
    expect((await errorOf(provider.search({ query: "\u{1F600}".repeat(71), maxResults: 5 }, signal)))).toMatchObject({ code: "invalid_request" });
    expect(requests).toHaveLength(0); // over-limit queries never reached the transport
  });

  it("sends exactly one POST with the frozen body and Bearer authorization", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "zhipu-success.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = makeProvider(transport);
    const response = await provider.search({ query: "humanoid robot companies official website", maxResults: 20 }, new AbortController().signal);
    expect(response.provider).toBe("zhipu");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/paas/v4/web_search");
    expect(request.headers.authorization).toBe("Bearer sk-z-test-token");
    expect(request.headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(request.body!) as Record<string, unknown>;
    expect(sent).toEqual({
      search_query: "humanoid robot companies official website",
      search_engine: "search_pro",
      search_intent: false,
      count: 20,
      content_size: "medium",
    });
    expect(JSON.stringify(sent)).not.toContain("sk-z-test-token");
    expect(request.body).not.toContain("messages");
    expect(request.body).not.toContain("model");
    expect(request.body).not.toContain("chat");
    expect(request.body).not.toContain("stream");
  });

  it("rejects any exact timeRange before the transport (never approximates)", async () => {
    const { transport, requests } = scriptedTransport([]);
    const provider = makeProvider(transport);
    expect((await errorOf(provider.search({ query: "x", maxResults: 5, timeRange: { from: "2026-01-01", to: "2026-01-02" } }, new AbortController().signal)))).toMatchObject({ code: "invalid_request" });
    expect(requests).toHaveLength(0);
  });

  it("validates factory dependencies: exact endpoint and non-blank token", () => {
    const { transport } = scriptedTransport([]);
    const attacker: ProviderEndpoint = { origin: "https://attacker.example", pathPrefix: "/api/paas/v4/web_search" };
    const attackerClient = new ProviderHttpClient({ transport, endpoint: attacker });
    expect(() => createZhipuProvider({ client: attackerClient, token: "sk-t" })).toThrow(SearchProviderError);
    expect(() => createZhipuProvider({ client: zhipuClient(transport), token: "   " })).toThrow(SearchProviderError);
    expect(() => createZhipuProvider({ client: zhipuClient(transport), token: "sk-t" })).not.toThrow();
  });

  it("maps the success fixture to whitelisted fields with local rank and normalized date", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "zhipu-success.json"), "utf8"));
    const provider = makeProvider(scriptedTransport([() => jsonResponse(200, body)]).transport);
    const response = await provider.search({ query: "humanoid robot companies official website", maxResults: 20 }, new AbortController().signal);
    expect(response.results).toHaveLength(2);
    expect(response.results[0]).toEqual({
      title: "Official Site",
      url: "https://example.com/",
      snippet: "The official example site.",
      rank: 1,
      provider: "zhipu",
      date: "2026-08-31",
    });
    // non-calendar publish_date is omitted
    expect(response.results[1]).toEqual({
      title: "Second Result",
      url: "https://other.example/path",
      snippet: "Another synthetic result.",
      rank: 2,
      provider: "zhipu",
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("request_id");
    expect(serialized).not.toContain("search_intent");
    expect(serialized).not.toContain("icon");
    expect(serialized).not.toContain("provider_code");
  });

  it("returns zero results and maps errors to stable codes", async () => {
    const zero = JSON.parse(readFileSync(join(FIXTURES, "zhipu-zero.json"), "utf8"));
    const zeroProvider = makeProvider(scriptedTransport([() => jsonResponse(200, zero)]).transport);
    const zeroResponse = await zeroProvider.search({ query: "x", maxResults: 20 }, new AbortController().signal);
    expect(zeroResponse.results).toHaveLength(0);

    async function zhipuError(script: Array<() => ProviderTransportResponse>): Promise<SearchProviderError> {
      const { transport } = scriptedTransport(script);
      const provider = makeProvider(transport);
      return (await errorOf(provider.search({ query: "x", maxResults: 20 }, new AbortController().signal))) as SearchProviderError;
    }
    expect((await zhipuError([() => jsonResponse(200, { request_id: "r1" })])).code).toBe("malformed_response"); // search_result missing
    expect((await zhipuError([() => jsonResponse(200, { search_result: { not: "array" } })])).code).toBe("malformed_response");
    expect((await zhipuError([() => jsonResponse(200, { search_result: [{ title: 42, link: "https://x.example/", content: "s" }] })])).code).toBe("malformed_response");
    expect((await zhipuError([() => jsonResponse(200, { search_result: [{ title: "A", link: "javascript:bad", content: "s" }] })])).code).toBe("dangerous_url");
    expect((await zhipuError([() => rawResponse(401, "nope")])).code).toBe("unauthorized");
    const retry = (await zhipuError([() => rawResponse(429, "slow", { "retry-after": "3" })])) as unknown as { code: string; retryAfterMs?: number };
    expect(retry.code).toBe("rate_limited");
    expect(retry.retryAfterMs).toBe(3000);
    expect((await zhipuError([() => rawResponse(503, "down")])).code).toBe("provider_unavailable");
    expect((await zhipuError([() => rawResponse(200, "{not-json")])).code).toBe("malformed_response");
    // secret-bearing raw error never leaks the secret or the bearer token
    const secret = (await zhipuError([() => rawResponse(500, "{\"error\":\"sk-z-secret\"}")])) as unknown as { code: string };
    expect(secret.code).toBe("provider_unavailable");
    expect(String(secret)).not.toContain("sk-z-secret");
    expect(String(secret)).not.toContain("sk-z-test-token");
    expect(String(secret)).not.toContain("Bearer");
    // 401 is a single attempt
    const { transport, requests } = scriptedTransport([() => rawResponse(401, "nope")]);
    const single = makeProvider(transport);
    const authError = (await errorOf(single.search({ query: "x", maxResults: 20 }, new AbortController().signal))) as SearchProviderError;
    expect(authError.code).toBe("unauthorized");
    expect(requests).toHaveLength(1);
    // pre-abort propagates as cancelled
    const preAborted = new AbortController();
    preAborted.abort();
    const abortProvider = makeProvider(scriptedTransport([]).transport);
    expect((await errorOf(abortProvider.search({ query: "x", maxResults: 20 }, preAborted.signal)))).toMatchObject({ code: "cancelled" });
  });
});
