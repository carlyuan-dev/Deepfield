import { ProviderHttpClient, type ProviderEndpoint } from "../provider-http-client.js";
import {
  SearchProviderError,
  assertValidSearchRequest,
  normalizeSearchResults,
  type NormalizedSearchResponse,
  type SearchProvider,
  type SearchRequest,
} from "../search-provider.js";

/** Tavily Search API: POST /search with api_key in the JSON body. */
export const ENDPOINT: ProviderEndpoint = {
  origin: "https://api.tavily.com",
  pathPrefix: "/search",
};

export interface TavilyProviderDeps {
  client: ProviderHttpClient;
  /** API key; injected only inside the Utility process, never logged. */
  token: string;
  allowCustomEndpoint?: boolean;
}

function assertClientEndpoint(client: ProviderHttpClient, expected: ProviderEndpoint): void {
  const actual = client.endpoint;
  if (actual.origin !== expected.origin || actual.pathPrefix !== expected.pathPrefix) {
    // stable safe error: never carries the token or the mismatched origin
    throw new SearchProviderError("invalid_request");
  }
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new SearchProviderError("malformed_response");
  }
}

export function createTavilyProvider(deps: TavilyProviderDeps): SearchProvider {
  const { client, token } = deps;
  if (deps.allowCustomEndpoint !== true) assertClientEndpoint(client, ENDPOINT);
  return {
    id: "tavily",
    capabilities: { timeRange: true },
    async search(request: SearchRequest, signal): Promise<NormalizedSearchResponse> {
      assertValidSearchRequest(request);
      const body: Record<string, unknown> = {
        api_key: token,
        query: request.query,
        max_results: request.maxResults,
      };
      if (request.timeRange !== undefined) {
        // Tavily supports start_date/end_date (YYYY-MM-DD)
        body.start_date = request.timeRange.from;
        body.end_date = request.timeRange.to;
      }
      const response = await client.request({
        method: "POST",
        path: ENDPOINT.pathPrefix,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      const payload = parseJson(response.body) as { results?: unknown };
      const raw = payload.results;
      if (!Array.isArray(raw)) {
        throw new SearchProviderError("malformed_response");
      }
      return normalizeSearchResults(
        "tavily",
        raw.map((entry) => {
          const result = entry as Record<string, unknown>;
          return { title: result.title, url: result.url, snippet: result.content, date: result.published_date };
        }),
        request.maxResults,
      );
    },
  };
}
