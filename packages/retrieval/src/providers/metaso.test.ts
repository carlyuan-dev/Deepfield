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
import { SearchProviderError } from "../search-provider.js";
import { METASO_ENDPOINT, createMetaSoProvider } from "./metaso.js";

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

function metasoClient(transport: ProviderTransport): ProviderHttpClient {
  return new ProviderHttpClient({ transport, endpoint: METASO_ENDPOINT });
}

function makeProvider(transport: ProviderTransport) {
  return createMetaSoProvider({ client: metasoClient(transport), token: "sk-meta-boundary" });
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("metaso strict search adapter (focused revision)", () => {
  it("pins the endpoint and validates factory dependencies", () => {
    expect(METASO_ENDPOINT).toEqual({ origin: "https://metaso.cn", pathPrefix: "/api/v1/search" });
    const { transport } = scriptedTransport([]);
    const attacker: ProviderEndpoint = { origin: "https://attacker.example", pathPrefix: "/api/v1/search" };
    const attackerClient = new ProviderHttpClient({ transport, endpoint: attacker });
    expect(() => createMetaSoProvider({ client: attackerClient, token: "sk-t" })).toThrow(SearchProviderError);
    expect(() => createMetaSoProvider({ client: metasoClient(transport), token: "   " })).toThrow(SearchProviderError);
    expect(() => createMetaSoProvider({ client: metasoClient(transport), token: "sk-t" })).not.toThrow();
  });

  it("sends exactly one POST with the frozen body, one auth header and no token in the body", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "metaso-success.json"), "utf8"));
    const { transport, requests } = scriptedTransport([() => jsonResponse(200, body)]);
    const provider = makeProvider(transport);
    const response = await provider.search({ query: "人形机器人 公司", maxResults: 20 }, new AbortController().signal);
    expect(response.provider).toBe("metaso");
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/v1/search");
    expect(request.headers.authorization).toBe("Bearer sk-meta-boundary");
    expect(Object.keys(request.headers).filter((key) => /authorization/i.test(key))).toHaveLength(1);
    expect(request.headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(request.body!) as Record<string, unknown>;
    expect(sent).toEqual({
      q: "人形机器人 公司",
      scope: "webpage",
      size: 20,
      includeSummary: false,
      includeRawContent: false,
      conciseSnippet: true,
    });
    expect(JSON.stringify(sent)).not.toContain("sk-meta-boundary");
    expect(request.body).not.toContain("chat");
    expect(request.body).not.toContain("includeRawContent\":true");
  });

  it("rejects any exact timeRange before the transport", async () => {
    const { transport, requests } = scriptedTransport([]);
    const provider = makeProvider(transport);
    const error = (await errorOf(provider.search({ query: "x", maxResults: 5, timeRange: { from: "2026-01-01", to: "2026-01-02" } }, new AbortController().signal))) as SearchProviderError;
    expect(error.code).toBe("invalid_request");
    expect(requests).toHaveLength(0);
  });

  it("maps the success fixture with local ranks and normalized date only", async () => {
    const body = JSON.parse(readFileSync(join(FIXTURES, "metaso-success.json"), "utf8"));
    const provider = makeProvider(scriptedTransport([() => jsonResponse(200, body)]).transport);
    const response = await provider.search({ query: "x", maxResults: 20 }, new AbortController().signal);
    expect(response.results).toHaveLength(2);
    expect(response.results[0]).toEqual({
      title: "Official Site",
      url: "https://example.com/",
      snippet: "Synthetic snippet one from an invented page.",
      rank: 1,
      provider: "metaso",
      date: "2026-08-31",
    });
    expect(response.results[1]).toEqual({
      title: "Second Result",
      url: "https://other.example/path",
      snippet: "Synthetic snippet two from another invented page.",
      rank: 2,
      provider: "metaso",
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("position");
    expect(serialized).not.toContain("score");
    expect(serialized).not.toContain("credits");
    expect(serialized).not.toContain("total");
    expect(serialized).not.toContain("searchParameters");
    expect(serialized).not.toContain("0.99");
  });

  it("returns zero results for the empty fixture", async () => {
    const zero = JSON.parse(readFileSync(join(FIXTURES, "metaso-zero.json"), "utf8"));
    const provider = makeProvider(scriptedTransport([() => jsonResponse(200, zero)]).transport);
    const response = await provider.search({ query: "x", maxResults: 20 }, new AbortController().signal);
    expect(response.results).toHaveLength(0);
  });

  it("maps failures to stable codes without leaking payloads or tokens", async () => {
    async function metasoError(script: Array<() => ProviderTransportResponse>): Promise<SearchProviderError> {
      const { transport } = scriptedTransport(script);
      const provider = makeProvider(transport);
      return (await errorOf(provider.search({ query: "x", maxResults: 20 }, new AbortController().signal))) as SearchProviderError;
    }
    expect((await metasoError([() => jsonResponse(200, { credits: 1 })])).code).toBe("malformed_response"); // webpages missing
    expect((await metasoError([() => jsonResponse(200, { webpages: { not: "array" } })])).code).toBe("malformed_response");
    expect((await metasoError([() => jsonResponse(200, { webpages: [{ title: 42, link: "https://x.example/", snippet: "s" }] })])).code).toBe("malformed_response");
    expect((await metasoError([() => jsonResponse(200, { webpages: [{ title: "A", link: "javascript:bad", snippet: "s" }] })])).code).toBe("dangerous_url");
    expect((await metasoError([() => jsonResponse(200, { webpages: [{ title: "A", link: "https://x.example/", snippet: 42 }] })])).code).toBe("malformed_response");
    expect((await metasoError([() => rawResponse(401, "nope")])).code).toBe("unauthorized");
    const retry = (await metasoError([() => rawResponse(429, "slow", { "retry-after": "3" })])) as unknown as { code: string; retryAfterMs?: number };
    expect(retry.code).toBe("rate_limited");
    expect(retry.retryAfterMs).toBe(3000);
    expect((await metasoError([() => rawResponse(503, "down")])).code).toBe("provider_unavailable");
    expect((await metasoError([() => rawResponse(200, "{not-json")])).code).toBe("malformed_response");
    // a secret-bearing raw provider body never leaks
    const secretError = (await metasoError([() => rawResponse(500, "{\"error\":\"sk-metaso-secret\"}")])) as unknown as { code: string };
    expect(secretError.code).toBe("provider_unavailable");
    expect(String(secretError)).not.toContain("sk-metaso-secret");
    expect(String(secretError)).not.toContain("sk-meta-boundary");
    expect(String(secretError)).not.toContain("Bearer");
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
