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
 * MetaSo Search-mode API (never the chat completions endpoint): POST
 * /api/v1/search with a single Authorization Bearer header.
 */
export const METASO_ENDPOINT: ProviderEndpoint = {
  origin: "https://metaso.cn",
  pathPrefix: "/api/v1/search",
};

export interface MetaSoProviderDeps {
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

function requireJsonPayload(payload: unknown): asserts payload is { webpages?: unknown } {
  // plain non-null, non-array JSON object BEFORE any field access; never a native TypeError
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new SearchProviderError("malformed_response");
  }
}

/** Keeps only a leading real YYYY-MM-DD from date-shaped strings; anything else is omitted. */
function normalizeMetaSoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 10) {
    return undefined; // absent or not date-shaped: omitted, never guessed
  }
  const candidate = value.slice(0, 10);
  return isValidDateString(candidate) ? candidate : undefined;
}

export function createMetaSoProvider(deps: MetaSoProviderDeps): SearchProvider {
  const { client, token } = deps;
  assertClientEndpoint(client, METASO_ENDPOINT);
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new SearchProviderError("invalid_request");
  }
  return {
    id: "metaso",
    capabilities: { timeRange: false },
    async search(request: SearchRequest, signal): Promise<NormalizedSearchResponse> {
      assertValidSearchRequest(request);
      if (request.timeRange !== undefined) {
        // exact ranges unsupported: reject before I/O, never approximate
        throw new SearchProviderError("invalid_request");
      }
      const body = {
        q: request.query,
        scope: "webpage",
        size: request.maxResults,
        includeSummary: false,
        includeRawContent: false,
        conciseSnippet: true,
      };
      const response = await client.request({
        method: "POST",
        path: METASO_ENDPOINT.pathPrefix,
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
      if (!Array.isArray(payload.webpages)) {
        throw new SearchProviderError("malformed_response");
      }
      return normalizeSearchResults(
        "metaso",
        payload.webpages.map((entry) => {
          // each entry must be a non-null, non-array object BEFORE field access
          if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            throw new SearchProviderError("malformed_response");
          }
          const result = entry as Record<string, unknown>;
          // map ONLY title/link/snippet/date: position, score, credits, total
          // and echoed search parameters are never read
          const date = normalizeMetaSoDate(result.date);
          return {
            title: result.title,
            url: result.link,
            snippet: result.snippet,
            ...(date !== undefined ? { date } : {}),
          };
        }),
        request.maxResults,
      );
    },
  };
}
