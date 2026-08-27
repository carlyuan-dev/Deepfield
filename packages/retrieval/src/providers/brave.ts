import { ProviderHttpClient, type ProviderEndpoint } from "../provider-http-client.js";
import {
  SearchProviderError,
  assertValidSearchRequest,
  normalizeSearchResults,
  type NormalizedSearchResponse,
  type SearchProvider,
  type SearchRequest,
} from "../search-provider.js";

/** Brave Search API (web search): GET /res/v1/web/search with X-Subscription-Token. */
export const ENDPOINT: ProviderEndpoint = {
  origin: "https://api.search.brave.com",
  pathPrefix: "/res/v1/web/search",
};

// Brave's official hard query limits: 400 characters and 50 words.
const BRAVE_MAX_QUERY_CHARS = 400;
const BRAVE_MAX_QUERY_WORDS = 50;

export interface BraveProviderDeps {
  client: ProviderHttpClient;
  /** API key; injected only inside the Utility process, never logged. */
  token: string;
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new SearchProviderError("malformed_response");
  }
}

export function createBraveProvider(deps: BraveProviderDeps): SearchProvider {
  const { client, token } = deps;
  return {
    id: "brave",
    capabilities: { timeRange: true },
    async search(request: SearchRequest, signal): Promise<NormalizedSearchResponse> {
      assertValidSearchRequest(request);
      const query = request.query;
      const wordCount = query.trim().split(/\s+/).filter((word) => word.length > 0).length;
      if (query.length > BRAVE_MAX_QUERY_CHARS || wordCount > BRAVE_MAX_QUERY_WORDS) {
        throw new SearchProviderError("invalid_request");
      }
      const params = new URLSearchParams({ q: query, count: String(request.maxResults) });
      if (request.timeRange !== undefined) {
        // Brave web search supports freshness=YYYY-MM-DDtoYYYY-MM-DD
        params.set("freshness", `${request.timeRange.from}to${request.timeRange.to}`);
      }
      const response = await client.request({
        method: "GET",
        path: `${ENDPOINT.pathPrefix}?${params.toString()}`,
        headers: {
          "X-Subscription-Token": token,
          accept: "application/json",
        },
        signal,
      });
      const payload = parseJson(response.body) as { web?: { results?: unknown } };
      const raw = payload.web?.results;
      if (!Array.isArray(raw)) {
        throw new SearchProviderError("malformed_response");
      }
      return normalizeSearchResults(
        "brave",
        raw.map((entry) => {
          const result = entry as Record<string, unknown>;
          return { title: result.title, url: result.url, snippet: result.description };
        }),
        request.maxResults,
      );
    },
  };
}
