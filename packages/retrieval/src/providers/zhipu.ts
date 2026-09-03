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
 * Zhipu independent Web Search API (never the Chat API): POST
 * /api/paas/v4/web_search with Authorization: Bearer.
 */
export const ZHIPU_ENDPOINT: ProviderEndpoint = {
  origin: "https://open.bigmodel.cn",
  pathPrefix: "/api/paas/v4/web_search",
};

const ZHIPU_MAX_CODE_POINTS = 70;

export interface ZhipuProviderDeps {
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

/** Array.from(value).length semantics: one per Unicode code point (astral chars count once). */
export function countUnicodeCodePoints(value: string): number {
  return Array.from(value).length;
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new SearchProviderError("malformed_response");
  }
}

function requireJsonPayload(payload: unknown): asserts payload is { search_result?: unknown } {
  // plain non-null, non-array JSON object BEFORE any field access; never a native TypeError
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SearchProviderError("malformed_response");
  }
}

/** publish_date keeps only a leading real YYYY-MM-DD; anything else is omitted. */
function normalizePublishDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 10) {
    return undefined; // absent or not date-shaped: omitted, never guessed
  }
  const candidate = value.slice(0, 10);
  return isValidDateString(candidate) ? candidate : undefined;
}

export function createZhipuProvider(deps: ZhipuProviderDeps): SearchProvider {
  const { client, token } = deps;
  assertClientEndpoint(client, ZHIPU_ENDPOINT);
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new SearchProviderError("invalid_request");
  }
  return {
    id: "zhipu",
    capabilities: { timeRange: false },
    async search(request: SearchRequest, signal): Promise<NormalizedSearchResponse> {
      assertValidSearchRequest(request);
      if (request.timeRange !== undefined) {
        // exact ranges unsupported: reject before I/O, never approximate
        throw new SearchProviderError("invalid_request");
      }
      if (countUnicodeCodePoints(request.query) > ZHIPU_MAX_CODE_POINTS) {
        throw new SearchProviderError("invalid_request");
      }
      const body = {
        search_query: request.query,
        search_engine: "search_pro",
        search_intent: false,
        count: request.maxResults,
        content_size: "medium",
      };
      const response = await client.request({
        method: "POST",
        path: ZHIPU_ENDPOINT.pathPrefix,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`, // token never enters the body
        },
        body: JSON.stringify(body),
        signal,
      });
      const payload = parseJson(response.body);
      requireJsonPayload(payload);
      if (!Array.isArray(payload.search_result)) {
        throw new SearchProviderError("malformed_response");
      }
      return normalizeSearchResults(
        "zhipu",
        payload.search_result.map((entry) => {
          // each entry must be a non-null, non-array object BEFORE field access
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new SearchProviderError("malformed_response");
          }
          const result = entry as Record<string, unknown>;
          // whitelist only: request ids, icons, intent and diagnostics are never read
          const date = normalizePublishDate(result.publish_date);
          return {
            title: result.title,
            url: result.link,
            snippet: result.content,
            ...(date !== undefined ? { date } : {}),
          };
        }),
        request.maxResults,
      );
    },
  };
}
