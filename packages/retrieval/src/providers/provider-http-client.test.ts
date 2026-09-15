import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  ProviderHttpClient,
  parseRetryAfter,
  validateEndpoint,
  validateRequestPath,
  type ProviderEndpoint,
  type ProviderTransport,
  type ProviderTransportResponse,
} from "../provider-http-client.js";
import { ENDPOINT as BRAVE_ENDPOINT } from "./brave.js";

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

describe("provider http client (focused revision)", () => {
  it("binds and validates the fixed endpoint at construction", () => {
    expect(() => validateEndpoint({ origin: "http://api.search.brave.com", pathPrefix: "/x" })).toThrow(/https/i);
    expect(() => validateEndpoint({ origin: "https://user:pass@api.example.com", pathPrefix: "/x" })).toThrow(/credential/i);
    expect(() => validateEndpoint({ origin: "https://api.example.com?q=1", pathPrefix: "/x" })).toThrow(/query/i);
    expect(() => validateEndpoint({ origin: "https://api.example.com#frag", pathPrefix: "/x" })).toThrow(/hash/i);
    expect(() => validateEndpoint({ origin: "https://api.example.com/path", pathPrefix: "/x" })).toThrow(/path/i);
    expect(() => validateEndpoint({ origin: "https://api.example.com", pathPrefix: "x" })).toThrow(/pathPrefix/i);
    expect(() => validateEndpoint({ origin: "https://api.example.com", pathPrefix: "/a/../b" })).toThrow(/pathPrefix/i);
    expect(validateEndpoint({ origin: "https://api.search.brave.com", pathPrefix: "/res/v1/web/search" }))
      .toEqual({ origin: "https://api.search.brave.com", pathPrefix: "/res/v1/web/search" });
  });

  it("rejects config values that are not positive integers", () => {
    expect(() => new ProviderHttpClient({ transport: scriptedTransport([]).transport, endpoint: BRAVE_ENDPOINT, maxResponseBytes: 0 })).toThrow(/maxResponseBytes/);
    expect(() => new ProviderHttpClient({ transport: scriptedTransport([]).transport, endpoint: BRAVE_ENDPOINT, maxResponseBytes: 1.5 })).toThrow(/maxResponseBytes/);
    expect(() => new ProviderHttpClient({ transport: scriptedTransport([]).transport, endpoint: BRAVE_ENDPOINT, totalTimeoutMs: -1 })).toThrow(/totalTimeoutMs/);
  });

  it("never lets a caller replace the origin or path: the transport is never called", async () => {
    const { transport, requests } = scriptedTransport([() => rawResponse(200, "{}")]);
    const client = clientFor(transport);
    // absolute URL, scheme-relative, traversal and out-of-prefix paths are all
    // rejected BEFORE the transport sees them
    for (const path of [
      "https://attacker.example/x",
      "//attacker.example/x",
      "/res/v1/web/search/../../etc",
      "/other/prefix?q=x",
      "/res/v1/web/searchX?q=x",
      "/res/v1/web/sear\u0000ch",
    ]) {
      await expect(client.request({ ...REQUEST, path })).rejects.toThrow(/path/i);
    }
    expect(requests).toHaveLength(0); // the transport was never contacted
    expect(validateRequestPath("/res/v1/web/search", "/res/v1/web/search?q=x")).toBe("/res/v1/web/search?q=x");
  });

  it("rejects redirects, 401, 429 (with Retry-After bounds) and non-special 4xx/5xx with stable codes", async () => {
    const client = clientFor(scriptedTransport([() => rawResponse(302, "", { location: "https://evil.example" })]).transport);
    await expect(client.request(REQUEST)).rejects.toMatchObject({ code: "redirect_blocked" });

    const client401 = clientFor(scriptedTransport([() => rawResponse(401, "unauthorized")]).transport);
    await expect(client401.request(REQUEST)).rejects.toMatchObject({ code: "unauthorized" });

    const client429 = clientFor(scriptedTransport([() => rawResponse(429, "slow down", { "retry-after": "5" })]).transport);
    const rateError = await errorOf(client429.request(REQUEST));
    expect(rateError).toMatchObject({ code: "rate_limited", retryAfterMs: 5000 });

    // 400/404/422 and 5xx must never be treated as success JSON
    for (const status of [400, 404, 422, 500, 503]) {
      const clientStatus = clientFor(scriptedTransport([() => rawResponse(status, `{"error":"body-${status}"}`)]).transport);
      const error = await errorOf(clientStatus.request(REQUEST));
      expect(error).toMatchObject({ code: "provider_unavailable" });
      expect(String(error)).not.toContain(`body-${status}`);
    }
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
      client.request({ ...REQUEST, maxResponseBytes: 100 }),
    ).rejects.toMatchObject({ code: "response_too_large" });

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(
      client.request({ ...REQUEST, signal: preAborted.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("never lets a single call raise the constructor hard byte cap", async () => {
    const hardMaxClient = new ProviderHttpClient({
      transport: scriptedTransport([() => ({
        statusCode: 200,
        headers: {},
        body: Readable.from([Buffer.from("x".repeat(200))]),
        destroy() {},
      })]).transport,
      endpoint: BRAVE_ENDPOINT,
      maxResponseBytes: 100,
    });
    // requested 1000 > hard 100: the hard cap wins -> too large
    await expect(
      hardMaxClient.request({ ...REQUEST, maxResponseBytes: 1000 }),
    ).rejects.toMatchObject({ code: "response_too_large" });
    // requested 50 <= hard 100: the smaller request cap applies (50 ok)
    const small = new ProviderHttpClient({
      transport: scriptedTransport([() => ({
        statusCode: 200,
        headers: {},
        body: Readable.from([Buffer.from("x".repeat(50))]),
        destroy() {},
      })]).transport,
      endpoint: BRAVE_ENDPOINT,
      maxResponseBytes: 100,
    });
    const smallResponse = await small.request({ ...REQUEST, maxResponseBytes: 50 });
    expect(smallResponse.body.length).toBe(50);
  });

  it("rejects invalid per-request byte caps before the transport is called", async () => {
    const { transport, requests } = scriptedTransport([() => rawResponse(200, "{}")]);
    const client = clientFor(transport);
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(client.request({ ...REQUEST, maxResponseBytes: bad })).rejects.toThrow(/maxResponseBytes/);
    }
    expect(requests).toHaveLength(0);
  });

  it("exposes the bound endpoint read-only and frozen", () => {
    const client = clientFor(scriptedTransport([]).transport);
    expect(client.endpoint).toEqual(BRAVE_ENDPOINT);
    expect(Object.isFrozen(client.endpoint)).toBe(true);
  });

  it("never leaks authorization or keys into errors", async () => {
    const client = clientFor(scriptedTransport([() => ({
      statusCode: 500,
      headers: {},
      body: Readable.from([Buffer.from('{"error":"sk-secret-key-value"}')]),
      destroy() {},
    })]).transport);
    const error = await errorOf(
      client.request({
        ...REQUEST,
        headers: { "X-Subscription-Token": "sk-visible-token", authorization: "Bearer sk-visible-token" },
      }),
    );
    expect(String(error)).not.toContain("sk-secret-key-value");
    expect(String(error)).not.toContain("sk-visible-token");
    expect(String(error)).not.toContain("Bearer");
  });
});
