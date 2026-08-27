import { ProviderHttpClient, type ProviderEndpoint } from "../provider-http-client.js";
import {
  SearchProviderError,
  assertValidSearchRequest,
  normalizeSearchResults,
  type NormalizedSearchResponse,
  type SearchProvider,
  type SearchRequest,
} from "../search-provider.js";

/** Serper.dev Google Search API: POST /search with X-API-KEY header. */
export const ENDPOINT: ProviderEndpoint = {
  origin: "https://google.serper.dev",
  pathPrefix: "/search",
};

export interface SerperProviderDeps {
  client: ProviderHttpClient;
  /** API key; injected only inside the Utility process, never logged. */
  token: string;
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

export function createSerperProvider(deps: SerperProviderDeps): SearchProvider {
  const { client, token } = deps;
  assertClientEndpoint(client, ENDPOINT);
  return {
    id: "serper",
    // Serper's Google Search API (official openapi) exposes no date-range
    // parameter: the capability is declared false and timeRange is REJECTED
    // up front rather than silently ignored.
    capabilities: { timeRange: false },
    async search(request: SearchRequest, signal): Promise<NormalizedSearchResponse> {
      assertValidSearchRequest(request);
      if (request.timeRange !== undefined) {
        throw new SearchProviderError("invalid_request");
      }
      const response = await client.request({
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
