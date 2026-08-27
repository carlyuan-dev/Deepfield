import { ProviderHttpClient, type ProviderEndpoint } from "../provider-http-client.js";
import {
  SearchProviderError,
  normalizeSearchResults,
  type NormalizedSearchResponse,
  type SearchProvider,
  type SearchRequest,
} from "../search-provider.js";

/** Serper.dev Google Search API: POST /search with X-API-KEY header. */
const ENDPOINT: ProviderEndpoint = {
  origin: "https://google.serper.dev",
  pathPrefix: "/search",
};

export interface SerperProviderDeps {
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

export function createSerperProvider(deps: SerperProviderDeps): SearchProvider {
  const { client, token } = deps;
  return {
    id: "serper",
    async search(request: SearchRequest, signal): Promise<NormalizedSearchResponse> {
      const response = await client.request(ENDPOINT, {
        method: "POST",
        path: ENDPOINT.pathPrefix,
        headers: {
          "X-API-KEY": token,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ q: request.query, num: request.maxResults }),
        signal,
      });
      const payload = parseJson(response.body) as { organic?: unknown };
      const raw = payload.organic;
      if (!Array.isArray(raw)) {
        throw new SearchProviderError("malformed_response");
      }
      return normalizeSearchResults(
        "serper",
        raw.map((entry) => {
          const result = entry as Record<string, unknown>;
          return { title: result.title, url: result.link, snippet: result.snippet, date: result.date };
        }),
        request.maxResults,
      );
    },
  };
}
