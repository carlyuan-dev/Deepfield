import { ProviderHttpClient, type ProviderEndpoint } from "../provider-http-client.js";
import {
  SearchProviderError,
  normalizeSearchResults,
  type NormalizedSearchResponse,
  type SearchProvider,
  type SearchRequest,
} from "../search-provider.js";

/** Brave Search API (web search): GET /res/v1/web/search with X-Subscription-Token. */
const ENDPOINT: ProviderEndpoint = {
  origin: "https://api.search.brave.com",
  pathPrefix: "/res/v1/web/search",
};

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
    async search(request: SearchRequest, signal): Promise<NormalizedSearchResponse> {
      const params = new URLSearchParams({ q: request.query, count: String(request.maxResults) });
      const response = await client.request(ENDPOINT, {
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
