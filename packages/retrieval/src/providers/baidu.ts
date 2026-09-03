import { ProviderHttpClient, type ProviderEndpoint } from "../provider-http-client.js";
import {
  SearchProviderError,
  assertValidSearchRequest,
  isValidDateString,
  normalizeSearchResults,
  type NormalizedSearchResponse,
  type SearchProvider,
  type SearchRequest,
} from "../search-provider.js";

/**
 * Baidu Qianfan basic Baidu Search (never /web_summary): POST
 * /v2/ai_search/web_search with one Bearer auth header.
 */
export const BAIDU_ENDPOINT: ProviderEndpoint = {
  origin: "https://qianfan.baidubce.com",
  pathPrefix: "/v2/ai_search/web_search",
};

export type BaiduAuthHeader = "authorization" | "x-appbuilder-authorization";

const BAIDU_MAX_QUERY_UNITS = 72;
const ALLOWED_AUTH_HEADERS = new Set<string>(["authorization", "x-appbuilder-authorization"]);
const HAN_PATTERN = /[\u4e00-\u9fff]/;

export interface BaiduProviderDeps {
  client: ProviderHttpClient;
  /** API key; injected only inside the Utility process, never logged. */
  token: string;
  /** Explicit header choice; NO default and no automatic retry with the other header. */
  authHeader: BaiduAuthHeader;
}

function assertClientEndpoint(client: ProviderHttpClient, expected: ProviderEndpoint): void {
  const actual = client.endpoint;
  if (actual.origin !== expected.origin || actual.pathPrefix !== expected.pathPrefix) {
    // stable safe error: never carries the token or the mismatched origin
    throw new SearchProviderError("invalid_request");
  }
}

/**
 * Baidu query budget: each Han code point counts as TWO units and every other
 * Unicode code point counts as ONE. Iteration is by code point, so astral
 * characters count once (never twice as UTF-16 units).
 */
export function countBaiduQueryUnits(query: string): number {
  let units = 0;
  for (const character of query) {
    units += HAN_PATTERN.test(character) ? 2 : 1;
  }
  return units;
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new SearchProviderError("malformed_response");
  }
}

/** A documented date-time like "2026-08-31 09:30:00" normalizes to its date. */
function normalizeBaiduDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 10) {
    return undefined; // absent or not date-shaped: omitted, never guessed
  }
  const candidate = value.slice(0, 10);
  return isValidDateString(candidate) ? candidate : undefined;
}

export function createBaiduProvider(deps: BaiduProviderDeps): SearchProvider {
  const { client, token, authHeader } = deps;
  assertClientEndpoint(client, BAIDU_ENDPOINT);
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new SearchProviderError("invalid_request");
  }
  if (!ALLOWED_AUTH_HEADERS.has(authHeader)) {
    throw new SearchProviderError("invalid_request");
  }
  return {
    id: "baidu",
    capabilities: { timeRange: true },
    async search(request: SearchRequest, signal): Promise<NormalizedSearchResponse> {
      assertValidSearchRequest(request);
      if (countBaiduQueryUnits(request.query) > BAIDU_MAX_QUERY_UNITS) {
        // never rely on provider-side truncation
        throw new SearchProviderError("invalid_request");
      }
      const body: Record<string, unknown> = {
        messages: [{ role: "user", content: request.query }],
        search_source: "baidu_search_v2",
        edition: "standard",
        resource_type_filter: [{ type: "web", top_k: request.maxResults }],
      };
      if (request.timeRange !== undefined) {
        body.search_filter = {
          range: {
            page_time: { gte: request.timeRange.from, lte: request.timeRange.to },
          },
        };
      }
      const response = await client.request({
        method: "POST",
        path: BAIDU_ENDPOINT.pathPrefix,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          [authHeader]: `Bearer ${token}`, // exactly ONE auth header, chosen explicitly
        },
        body: JSON.stringify(body),
        signal,
      });
      const payload = parseJson(response.body) as { references?: unknown };
      if (!Array.isArray(payload.references)) {
        throw new SearchProviderError("malformed_response");
      }
      return normalizeSearchResults(
        "baidu",
        payload.references.map((entry) => {
          const result = entry as Record<string, unknown>;
          // snippet wins; content is the fallback ONLY when snippet is absent;
          // authority/rerank/icon/raw-content/diagnostic fields are never read
          const snippet = result.snippet !== undefined ? result.snippet : result.content;
          return {
            title: result.title,
            url: result.url,
            snippet,
            ...(normalizeBaiduDate(result.date) !== undefined ? { date: normalizeBaiduDate(result.date) } : {}),
          };
        }),
        request.maxResults,
      );
    },
  };
}
