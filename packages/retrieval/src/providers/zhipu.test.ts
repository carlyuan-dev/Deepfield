import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderHttpClient, type ProviderTransport } from "../provider-http-client.js";
import { createZhipuProvider, ZHIPU_ENDPOINT } from "./zhipu.js";

describe("Zhipu web search adapter", () => {
  it("posts validated search fields and normalizes the success fixture", async () => {
    const fixture = readFileSync(join(import.meta.dirname, "fixtures/zhipu-success.json"), "utf8");
    const requests: Array<{ endpoint: unknown; method: string; path: string; headers: Record<string, string>; body?: string }> = [];
    const transport: ProviderTransport = {
      async request(endpoint, request) {
        requests.push({
          endpoint,
          method: request.method,
          path: request.path,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
        });
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: Readable.from([Buffer.from(fixture)]),
          destroy() {},
        };
      },
    };
    const provider = createZhipuProvider({
      client: new ProviderHttpClient({ transport, endpoint: ZHIPU_ENDPOINT }),
      token: "zhipu-token",
      searchEngine: "search_pro",
    });

    const response = await provider.search(
      { query: "具身智能 公司", maxResults: 2 },
      new AbortController().signal,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      endpoint: { origin: "https://open.bigmodel.cn", pathPrefix: "/api/paas/v4/web_search" },
      method: "POST",
      path: "/api/paas/v4/web_search",
      headers: { authorization: "Bearer zhipu-token" },
    });
    expect(JSON.parse(requests[0]!.body!)).toEqual({
      search_engine: "search_pro",
      search_query: "具身智能 公司",
      count: 2,
    });
    expect(response.results[0]).toEqual({
      title: "示例公司官网",
      url: "https://example.com/company",
      snippet: "示例公司的公开介绍。",
      rank: 1,
      provider: "zhipu",
      publishedAt: "2026-08-31",
      sourceName: "示例媒体",
    });
  });
});
