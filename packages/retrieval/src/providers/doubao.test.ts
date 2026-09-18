import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ProviderEndpoint, ProviderTransport, ProviderTransportRequest } from "../provider-http-client.js";
import { createSearchProvider } from "./provider-registry.js";

const transportState = vi.hoisted(() => ({ current: undefined as ProviderTransport | undefined }));
vi.mock("../provider-node-transport.js", () => ({ createNodeProviderTransport: () => transportState.current }));

// Envelope and field types verified against the official Custom API document:
// https://docs.volcengine.com/docs/87772/2272953?lang=zh (2026-09-17).
// Synthetic short content replaces the example's large tourism article.
const result = { Id: "result-1", SortId: 1, Title: "公司介绍", Url: "https://example.com/company", Snippet: "公司公开信息", Summary: "长摘要", Content: "不是已打开网页", SiteName: "示例媒体", PublishTime: "2026-08-22T09:16:00+08:00" };
const success = { ResponseMetadata: { RequestId: "test-request", Action: "WebSearch", Version: "2025-01-01", Service: "volc_torchlight_api", Region: "cn-beijing" }, Result: { ResultCount: 1, WebResults: [result], SearchContext: { OriginQuery: "公司", SearchType: "web" }, TimeCost: 1, LogId: "test-request", CardResults: null } };

function setup(body: unknown = success, statusCode = 200, baseUrl = "https://open.feedcoopapi.com") {
  const requests: Array<{ endpoint: ProviderEndpoint; request: ProviderTransportRequest }> = [];
  transportState.current = { async request(endpoint, request) {
    requests.push({ endpoint, request });
    return { statusCode, headers: { "content-type": "application/json", "retry-after": "3" }, body: Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]), destroy() {} };
  } };
  const provider = createSearchProvider({ id: "search", name: "豆包搜索 Custom", provider: "doubao", baseUrl, options: {}, apiKey: "search-only-secret" });
  return { provider, requests };
}
const request = { query: "公司", maxResults: 20 };
const signal = () => new AbortController().signal;

describe("Doubao Custom search", () => {
  it("posts the Custom web request and normalizes the documented Result.WebResults envelope", async () => {
    const { provider, requests } = setup();
    const response = await provider.search({ ...request, timeRange: { from: "2026-06-01", to: "2026-09-17" } }, signal());
    expect(requests[0]).toMatchObject({ endpoint: { origin: "https://open.feedcoopapi.com", pathPrefix: "/search_api/web_search" }, request: { method: "POST", path: "/search_api/web_search", headers: { authorization: "Bearer search-only-secret", "content-type": "application/json" } } });
    expect(requests[0]!.request.headers).not.toHaveProperty("X-Traffic-Tag");
    expect(JSON.parse(requests[0]!.request.body!)).toEqual({ SearchType: "web", Query: "公司", Count: 20, Filter: { NeedUrl: true, NeedContent: false }, TimeRange: "2026-06-01..2026-09-17" });
    expect(response).toEqual({ provider: "doubao", results: [{ title: "公司介绍", url: "https://example.com/company", snippet: "公司公开信息", sourceName: "示例媒体", date: "2026-08-22", rank: 1, provider: "doubao" }] });
    expect(JSON.stringify(response)).not.toMatch(/Content|Summary|RequestId|不是已打开网页/);
  });
  it("uses an editable HTTPS base path and treats empty results as success", async () => {
    const { provider, requests } = setup({ ...success, Result: { ResultCount: 0, WebResults: [] } }, 200, "https://proxy.example/custom/");
    expect(await provider.search(request, signal())).toEqual({ provider: "doubao", results: [] });
    expect(requests[0]).toMatchObject({ endpoint: { origin: "https://proxy.example", pathPrefix: "/custom/search_api/web_search" }, request: { path: "/custom/search_api/web_search" } });
    expect(JSON.parse(requests[0]!.request.body!)).not.toHaveProperty("TimeRange");
  });
  it("accepts exactly 100 Unicode code points and rejects overflow or invalid requests before dispatch", async () => {
    const { provider, requests } = setup();
    for (const query of ["字".repeat(100), "😀".repeat(100)]) {
      await provider.search({ query, maxResults: 1 }, signal());
      expect(JSON.parse(requests.at(-1)!.request.body!).Query).toBe(query);
    }
    for (const invalid of [{ query: "字".repeat(101), maxResults: 1 }, { query: "😀".repeat(101), maxResults: 1 }, { query: " ", maxResults: 1 }, { query: "公司", maxResults: 21 }, { ...request, timeRange: { from: "2026-02-30", to: "2026-03-01" } }]) {
      await expect(provider.search(invalid, signal())).rejects.toMatchObject({ code: "invalid_request" });
    }
    expect(requests).toHaveLength(2);
  });
  it.each([null, [], {}, { Result: null }, { Result: { WebResults: {} } }, { Result: { WebResults: [null] } }, { Result: { WebResults: [{ ...result, Title: 1 }] } }, "invalid JSON"].map((body) => [body]))("rejects malformed responses safely (%j)", async (body) => {
    await expect(setup(body).provider.search(request, signal())).rejects.toMatchObject({ code: "malformed_response" });
  });
  it.each([undefined, "javascript:alert(1)", "not a URL"])("rejects missing or unsafe result URLs (%s)", async (Url) => {
    await expect(setup({ ...success, Result: { WebResults: [{ ...result, Url }] } }).provider.search(request, signal())).rejects.toMatchObject({ code: "dangerous_url" });
  });
  it("omits unknown publication dates and absent optional media names", async () => {
    const response = await setup({ ...success, Result: { WebResults: [{ ...result, PublishTime: "unknown", SiteName: null }] } }).provider.search(request, signal());
    expect(response.results[0]).not.toHaveProperty("date");
    expect(response.results[0]).not.toHaveProperty("sourceName");
  });
  it.each([[401, "unauthorized"], [403, "unauthorized"], [429, "rate_limited"], [500, "provider_unavailable"]])("maps HTTP %s without response/credential leakage", async (status, code) => {
    const error = await setup({ secret: "search-only-secret" }, status as number).provider.search(request, signal()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("search-only-secret");
    if (status === 429) expect(error).toMatchObject({ retryAfterMs: 3000 });
  });
  it("recognizes documented application errors even with HTTP 200 and suppresses their text", async () => {
    const error = await setup({ ResponseMetadata: { Error: { CodeN: 10400, Code: "10400", Message: "query or search type is empty search-only-secret" } }, Result: null }).provider.search(request, signal()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_request" });
    expect(String(error)).not.toContain("search-only-secret");
  });
  it.each([
    [10401, "unauthorized"], [10402, "invalid_request"], [10403, "unauthorized"],
    [10406, "provider_unavailable"], [10408, "provider_unavailable"], [10409, "provider_unavailable"],
    [10410, "provider_unavailable"], [10412, "provider_unavailable"], [10500, "provider_unavailable"],
    [700429, "rate_limited"], ["constructor", "provider_unavailable"], ["__proto__", "provider_unavailable"],
  ])("handles application code %s with a fixed safe error", async (Code, code) => {
    await expect(setup({ ResponseMetadata: { Error: { Code, Message: "secret" } }, Result: null }).provider.search(request, signal())).rejects.toMatchObject({ code });
  });
  it("cancels an in-flight transport through the shared HTTP client", async () => {
    const { provider } = setup();
    const abort = new AbortController();
    let transportSignal: AbortSignal | undefined;
    transportState.current!.request = async (_endpoint, request) => {
      transportSignal = request.signal;
      abort.abort();
      return new Promise(() => {});
    };
    await expect(provider.search(request, abort.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(transportSignal?.aborted).toBe(true);
  });
  it("honors cancellation without dispatch", async () => {
    const { provider, requests } = setup();
    const abort = new AbortController(); abort.abort();
    await expect(provider.search(request, abort.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(requests).toHaveLength(0);
  });
});
