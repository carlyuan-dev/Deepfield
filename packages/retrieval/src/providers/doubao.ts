import type { ProviderHttpClient } from "../provider-http-client.js";
import {
  SearchProviderError,
  assertValidSearchRequest,
  isValidDateString,
  normalizeSearchResults,
  type SearchProvider,
  type SearchProviderErrorCode,
} from "../search-provider.js";

const MAX_DOUBAO_QUERY_LENGTH = 100;

// Custom API: https://docs.volcengine.com/docs/87772/2272953?lang=zh
// These are application codes in ResponseMetadata.Error, including HTTP 200.
const APPLICATION_ERRORS: Readonly<Record<string, SearchProviderErrorCode>> = {
  "10400": "invalid_request",
  "10401": "unauthorized",
  "10402": "invalid_request",
  "10403": "unauthorized",
  "700429": "rate_limited",
};

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SearchProviderError("malformed_response");
  }
  return value as Record<string, unknown>;
}

export function createDoubaoProvider(deps: { client: ProviderHttpClient; token: string }): SearchProvider {
  if (typeof deps.token !== "string" || deps.token.trim().length === 0) {
    throw new SearchProviderError("invalid_request");
  }
  return {
    id: "doubao",
    capabilities: { timeRange: true, maxQueryLength: MAX_DOUBAO_QUERY_LENGTH },
    async search(request, signal) {
      assertValidSearchRequest(request, MAX_DOUBAO_QUERY_LENGTH);
      const response = await deps.client.request({
        method: "POST",
        path: deps.client.endpoint.pathPrefix,
        headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          SearchType: "web",
          Query: request.query,
          Count: request.maxResults,
          Filter: { NeedUrl: true, NeedContent: false },
          ...(request.timeRange === undefined ? {} : { TimeRange: `${request.timeRange.from}..${request.timeRange.to}` }),
        }),
        signal,
      });
      let payload: unknown;
      try { payload = JSON.parse(response.body.toString("utf8")); }
      catch { throw new SearchProviderError("malformed_response"); }
      const root = object(payload);
      if (root.ResponseMetadata !== undefined) {
        const metadata = object(root.ResponseMetadata);
        if (metadata.Error !== undefined && metadata.Error !== null) {
          const error = object(metadata.Error);
          const code = error.CodeN ?? error.Code;
          const mapped = (typeof code === "number" || typeof code === "string") && Object.hasOwn(APPLICATION_ERRORS, String(code))
            ? APPLICATION_ERRORS[String(code)] : undefined;
          // Subscription/credit exhaustion, internal and unknown codes remain
          // unavailable; never expose upstream text or infer from Message.
          throw new SearchProviderError(mapped ?? "provider_unavailable");
        }
      }
      const results = object(root.Result).WebResults;
      if (!Array.isArray(results)) throw new SearchProviderError("malformed_response");
      return normalizeSearchResults("doubao", results.map((entry) => {
        const result = object(entry);
        const date = typeof result.PublishTime === "string" ? result.PublishTime.slice(0, 10) : undefined;
        return {
          title: result.Title,
          url: result.Url,
          snippet: result.Snippet,
          ...(result.SiteName == null ? {} : { sourceName: result.SiteName }),
          ...(date !== undefined && isValidDateString(date) ? { date } : {}),
        };
      }), request.maxResults);
    },
  };
}
