import { ProviderHttpClient, type ProviderEndpoint } from "../provider-http-client.js";
import {
  SearchProviderError,
  assertValidSearchRequest,
  normalizeSearchResults,
  type NormalizedSearchResponse,
  type SearchProvider,
  type SearchRequest,
} from "../search-provider.js";

export const ZHIPU_SEARCH_ENGINES = [
  "search_std",
  "search_pro",
  "search_pro_sogou",
  "search_pro_quark",
] as const;
export type ZhipuSearchEngine = (typeof ZHIPU_SEARCH_ENGINES)[number];

export const ZHIPU_ENDPOINT: ProviderEndpoint = {
  origin: "https://open.bigmodel.cn",
  pathPrefix: "/api/paas/v4/web_search",
};

export interface ZhipuProviderDeps {
  client: ProviderHttpClient;
  token: string;
  searchEngine?: ZhipuSearchEngine;
}

export function createZhipuProvider(deps: ZhipuProviderDeps): SearchProvider {
  const engine = deps.searchEngine ?? "search_std";
  if (!ZHIPU_SEARCH_ENGINES.includes(engine) || deps.token.trim().length === 0) {
    throw new SearchProviderError("invalid_request");
  }
  return {
    id: "zhipu",
    capabilities: { timeRange: false },
    async search(request: SearchRequest, signal): Promise<NormalizedSearchResponse> {
      assertValidSearchRequest(request);
      if (request.timeRange !== undefined) throw new SearchProviderError("invalid_request");
      const response = await deps.client.request({
        method: "POST",
        path: deps.client.endpoint.pathPrefix,
        headers: {
          authorization: `Bearer ${deps.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          search_engine: engine,
          search_query: request.query,
          count: request.maxResults,
        }),
        signal,
      });
      let payload: unknown;
      try { payload = JSON.parse(response.body.toString("utf8")); }
      catch { throw new SearchProviderError("malformed_response"); }
      if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { search_result?: unknown }).search_result)) {
        throw new SearchProviderError("malformed_response");
      }
      return normalizeSearchResults(
        "zhipu",
        (payload as { search_result: unknown[] }).search_result.map((entry) => {
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new SearchProviderError("malformed_response");
          }
          const result = entry as Record<string, unknown>;
          return {
            title: result.title,
            url: result.link,
            snippet: result.content,
            publishedAt: result.publish_date,
            sourceName: result.media,
          };
        }),
        request.maxResults,
      );
    },
  };
}
