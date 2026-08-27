import { ProviderHttpClient, type ProviderEndpoint } from "../provider-http-client.js";
import {
  SearchProviderError,
  normalizeSearchResults,
  type NormalizedSearchResponse,
  type SearchProvider,
  type SearchRequest,
} from "../search-provider.js";

/** Tavily Search API: POST /search with api_key in the JSON body. */
const ENDPOINT: ProviderEndpoint = {
  origin: "https://api.tavily.com",
  pathPrefix: "/search",
};

export interface TavilyProviderDeps {
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

export function createTavilyProvider(deps: TavilyProviderDeps): SearchProvider {
  const { client, token } = deps;
  return {
    id: "tavily",
    async search(request: SearchRequest, signal): Promise<NormalizedSearchResponse> {
      const body: Record<string, unknown> = {
        api_key: token,
        query: request.query,
        max_results: request.maxResults,
      };
      if (request.timeRange !== undefined) {
        body.start_date = request.timeRange.from;
        body.end_date = request.timeRange.to;
      }
      const response = await client.request(ENDPOINT, {
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
