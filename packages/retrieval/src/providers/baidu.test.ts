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
import {
  BAIDU_ENDPOINT,
  countBaiduQueryUnits,
  createBaiduProvider,
  type BaiduAuthHeader,
} from "./baidu.js";

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

function baiduClient(transport: ProviderTransport): ProviderHttpClient {
  return new ProviderHttpClient({ transport, endpoint: BAIDU_ENDPOINT });
}

function makeProvider(transport: ProviderTransport, authHeader: BaiduAuthHeader = "authorization", token = "sk-test-token") {
  return createBaiduProvider({ client: baiduClient(transport), token, authHeader });
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("baidu basic search adapter (focused revision)", () => {
  it("counts query units: Han code points x2, other Unicode code points x1", () => {
    expect(countBaiduQueryUnits("AI机器人")).toBe(8);
    expect(countBaiduQueryUnits("a".repeat(72))).toBe(72);
    expect(countBaiduQueryUnits("人".repeat(36))).toBe(72);
    // iteration is by code point, not UTF-16 code unit: each astral char is ONE unit
    expect(countBaiduQueryUnits("\u{1F600}".repeat(72))).toBe(72);
    expect("\u{1F600}".repeat(72).length).toBe(144); // 72 surrogate pairs in UTF-16
    expect(countBaiduQueryUnits("A\u{1F600}人")).toBe(4); // 1 + 1 + 2
  });

  it("counts EVERY Han code point x2 across all Script_Extensions=Han ranges", () => {
    // Extension A (U+3400) and Extension B astral Han (U+20000) each count as TWO
    expect(countBaiduQueryUnits("\u{3400}")).toBe(2);
    expect(countBaiduQueryUnits("\u{20000}")).toBe(2);
    expect(countBaiduQueryUnits("\u{20000}\u{3400}")).toBe(4);
    // ordinary astral non-Han (emoji) still counts ONE
    expect(countBaiduQueryUnits("\u{1F600}")).toBe(1);
    // mixed query accumulates per code point: 1 + 2 + 1 + 2
    expect(countBaiduQueryUnits("A\u{3400}\u{1F600}\u{20000}")).toBe(6);
  });

  it("rejects extension-Han queries over 72 units before the transport is called", async () => {
    const { transport, requests } = scriptedTransport([]);
    const provider = makeProvider(transport);
    const signal = new AbortController().signal;
    expect(countBaiduQueryUnits("\u{3400}".repeat(36))).toBe(72); // boundary is legal
    expect((await errorOf(provider.search({ query: "\u{3400}".repeat(37), maxResults: 20 }, signal)))).toMatchObject({ code: "invalid_request" });
    expect((await errorOf(provider.search({ query: "\u{20000}".repeat(37), maxResults: 20 }, signal)))).toMatchObject({ code: "invalid_request" });
    expect(requests).toHaveLength(0);
  });

  it("rejects over-limit queries before the transport is called", async () => {
    const { transport, requests } = scriptedTransport([]);
    const provider = makeProvider(transport);
    const signal = new AbortController().signal;
    expect((await errorOf(provider.search({ query: "a".repeat(73), maxResults: 20 }, signal)))).toMatchObject({ code: "invalid_request" });
    expect((await errorOf(provider.search({ query: "人".repeat(37), maxResults: 20 }, signal)))).toMatchObject({ code: "invalid_request" });
    expect(requests).toHaveLength(0);
  });

  it("sends exactly one POST with the frozen body and a single explicit auth header", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "baidu-success.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = makeProvider(transport, "authorization");
    const response = await provider.search({ query: "人形机器人 公司", maxResults: 20 }, new AbortController().signal);
    expect(response.provider).toBe("baidu");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v2/ai_search/web_search");
    expect(request.path).not.toContain("web_summary");
    expect(request.headers.authorization).toBe("Bearer sk-test-token");
    expect(request.headers["x-appbuilder-authorization"]).toBeUndefined(); // only ONE auth header
    expect(Object.keys(request.headers).filter((key) => /authorization/i.test(key))).toHaveLength(1);
    const sent = JSON.parse(request.body!) as Record<string, unknown>;
    expect(sent).toEqual({
      messages: [{ role: "user", content: "人形机器人 公司" }],
      search_source: "baidu_search_v2",
      edition: "standard",
      resource_type_filter: [{ type: "web", top_k: 20 }],
    });
    expect(JSON.stringify(sent)).not.toContain("sk-test-token"); // token never in the body
    expect(request.body).not.toContain("choices");
    expect(request.body).not.toContain("stream");
    expect(request.body).not.toContain("web_summary");
  });

  it("supports the alternative explicit auth header and never sends both", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "baidu-zero.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = makeProvider(transport, "x-appbuilder-authorization");
    await provider.search({ query: "x", maxResults: 20 }, new AbortController().signal);
    expect(requests[0]!.headers["x-appbuilder-authorization"]).toBe("Bearer sk-test-token");
    expect(requests[0]!.headers.authorization).toBeUndefined();
    expect(Object.keys(requests[0]!.headers).filter((key) => /authorization/i.test(key))).toHaveLength(1);
  });

  it("adds search_filter.range.page_time for an exact timeRange", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "baidu-zero.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = makeProvider(transport);
    await provider.search(
      { query: "x", maxResults: 5, timeRange: { from: "2026-01-01", to: "2026-08-31" } },
      new AbortController().signal,
    );
    const sent = JSON.parse(requests[0]!.body!) as { search_filter?: { range?: { page_time?: unknown } } };
    expect(sent.search_filter).toEqual({ range: { page_time: { gte: "2026-01-01", lte: "2026-08-31" } } });
  });

  it("validates factory dependencies: client endpoint, non-blank token and allowed auth header", () => {
    const { transport } = scriptedTransport([]);
    const attacker: ProviderEndpoint = { origin: "https://attacker.example", pathPrefix: "/v2/ai_search/web_search" };
    const attackerClient = new ProviderHttpClient({ transport, endpoint: attacker });
    expect(() => createBaiduProvider({ client: attackerClient, token: "sk-t", authHeader: "authorization" })).toThrow(SearchProviderError);
    expect(() => createBaiduProvider({ client: baiduClient(transport), token: "   ", authHeader: "authorization" })).toThrow(SearchProviderError);
    expect(() => createBaiduProvider({ client: baiduClient(transport), token: "sk-t", authHeader: "x-api-key" as BaiduAuthHeader })).toThrow(SearchProviderError);
    expect(() => createBaiduProvider({ client: baiduClient(transport), token: "sk-t", authHeader: "authorization" as BaiduAuthHeader })).not.toThrow();
  });

  it("maps the success fixture to whitelisted fields with local rank and normalized date", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "baidu-success.json"), "utf8"));
    const provider = makeProvider(scriptedTransport([() => jsonResponse(200, body)]).transport);
    const response = await provider.search({ query: "人形机器人 公司", maxResults: 20 }, new AbortController().signal);
    expect(response.results).toHaveLength(2);
    // snippet wins over content; date-time prefix normalized; local one-based rank
    expect(response.results[0]).toEqual({
      title: "Official Site",
      url: "https://example.com/",
      snippet: "From snippet field.",
      rank: 1,
      provider: "baidu",
      date: "2026-08-31",
    });
    // content fallback used only when snippet is absent; non-calendar date omitted
    expect(response.results[1]).toEqual({
      title: "Second Result",
      url: "https://other.example/path",
      snippet: "Content fallback used because snippet is absent.",
      rank: 2,
      provider: "baidu",
    });
    // no authority/rerank/icon/raw-content leaks into the serialized output
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("authority_score");
    expect(serialized).not.toContain("rerank_score");
    expect(serialized).not.toContain("icon");
    expect(serialized).not.toContain("Raw content one");
  });

  it("returns zero results for an empty references array", async () => {
    const zero = JSON.parse(readFileSync(join(FIXTURES, "baidu-zero.json"), "utf8"));
    const provider = makeProvider(scriptedTransport([() => jsonResponse(200, zero)]).transport);
    const response = await provider.search({ query: "x", maxResults: 20 }, new AbortController().signal);
    expect(response.results).toHaveLength(0);
  });

  it("maps errors to stable codes without leaking payloads or tokens", async () => {
    async function baiduError(script: Array<() => ProviderTransportResponse>): Promise<SearchProviderError> {
      const { transport } = scriptedTransport(script);
      const provider = makeProvider(transport);
      return (await errorOf(provider.search({ query: "人形机器人 公司", maxResults: 20 }, new AbortController().signal))) as SearchProviderError;
    }
    expect((await baiduError([() => jsonResponse(200, { code: 0 })])).code).toBe("malformed_response"); // references missing
    expect((await baiduError([() => jsonResponse(200, { references: { not: "array" } })])).code).toBe("malformed_response");
    expect((await baiduError([() => jsonResponse(200, { references: ["not-an-object"] })])).code).toBe("malformed_response");
    expect((await baiduError([() => jsonResponse(200, { references: [{ title: 42, url: "https://x.example/", snippet: "s" }] })])).code).toBe("malformed_response");
    expect((await baiduError([() => jsonResponse(200, { references: [{ title: "A", url: "javascript:bad", snippet: "s" }] })])).code).toBe("dangerous_url");
    expect((await baiduError([() => jsonResponse(200, { references: [{ title: "A", url: "https://x.example/" }] })])).code).toBe("malformed_response"); // both snippets absent
    expect((await baiduError([() => rawResponse(401, "nope")])).code).toBe("unauthorized");
    expect((await baiduError([() => rawResponse(429, "slow", { "retry-after": "3" })])).code).toBe("rate_limited");
    // the parsed Retry-After survives across the adapter boundary (it is the
    // client error propagated untouched, never rethrown with a fresh message)
    const retryError = (await baiduError([() => rawResponse(429, "slow", { "retry-after": "3" })])) as unknown as { code: string; retryAfterMs?: number };
    expect(retryError.code).toBe("rate_limited");
    expect(retryError.retryAfterMs).toBe(3000);
    expect((await baiduError([() => rawResponse(503, "down")])).code).toBe("provider_unavailable");    expect((await baiduError([() => rawResponse(200, "{not-json")])).code).toBe("malformed_response");
    expect((await baiduError([() => rawResponse(500, "{\"error\":\"sk-response-secret\"}")])).code).toBe("provider_unavailable");
    // 401 is a single attempt: no second request with another header
    const { transport, requests } = scriptedTransport([() => rawResponse(401, "nope")]);
    const provider = makeProvider(transport);
    const authError = (await errorOf(provider.search({ query: "x", maxResults: 20 }, new AbortController().signal))) as Error;
    expect(authError).toMatchObject({ code: "unauthorized" });
    expect(requests).toHaveLength(1);
    // no error ever leaks the raw payload or the bearer token
    for (const message of [String(authError), String(await baiduError([() => rawResponse(500, "{\"error\":\"sk-response-secret\"}")]))]) {
      expect(message).not.toContain("sk-response-secret");
      expect(message).not.toContain("sk-test-token");
      expect(message).not.toContain("Bearer");
    }
    // abort propagates as cancelled
    const preAborted = new AbortController();
    preAborted.abort();
    const { transport: abortTransport } = scriptedTransport([]);
    const abortProvider = makeProvider(abortTransport);
    expect((await errorOf(abortProvider.search({ query: "x", maxResults: 20 }, preAborted.signal)))).toMatchObject({ code: "cancelled" });
  });
});
