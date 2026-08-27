export const MAX_QUERY_LENGTH = 512;
export const MAX_RESULTS = 20;
export const MAX_RESULT_URL_LENGTH = 2048;
export const MAX_RESULT_TITLE_LENGTH = 2000;
export const MAX_RESULT_SNIPPET_LENGTH = 8000;
export const MAX_RESULT_DATE_LENGTH = 40;

export interface SearchRequest {
  query: string;
  /** 1..20 — enforced by the contract and the tool schema. */
  maxResults: number;
  /** Optional ISO-8601 time range (from/to inclusive). */
  timeRange?: { from: string; to: string };
}

export type SearchProviderErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "cancelled"
  | "response_too_large"
  | "malformed_response"
  | "redirect_blocked"
  | "network_unavailable"
  | "dangerous_url";

const FIXED_MESSAGES: Record<SearchProviderErrorCode, string> = {
  invalid_request: "invalid provider request",
  unauthorized: "provider authentication failed",
  rate_limited: "provider rate limit exceeded",
  provider_unavailable: "provider unavailable",
  timeout: "provider request timeout",
  cancelled: "provider request cancelled",
  response_too_large: "provider response too large",
  malformed_response: "malformed provider response",
  redirect_blocked: "provider redirect rejected",
  network_unavailable: "provider network failure",
  dangerous_url: "dangerous result url",
};

/** Stable, sanitized provider error: never carries keys, payloads or raw causes. */
export class SearchProviderError extends Error {
  readonly code: SearchProviderErrorCode;
  /** Optional parsed Retry-After (rate_limited only); undefined when absent/invalid. */
  readonly retryAfterMs?: number;

  constructor(code: SearchProviderErrorCode, retryAfterMs?: number) {
    super(FIXED_MESSAGES[code]);
    this.name = "SearchProviderError";
    this.code = code;
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

export interface NormalizedSearchResult {
  title: string;
  url: string;
  snippet: string;
  /** One-based, unique across the response. */
  rank: number;
  provider: string;
  /** Optional ISO-8601 date. */
  date?: string;
}

export interface NormalizedSearchResponse {
  provider: string;
  results: NormalizedSearchResult[];
}

/** A provider adapter: fixed endpoint, normalized output, sanitized errors. */
export interface SearchProvider {
  readonly id: string;
  search(request: SearchRequest, signal: AbortSignal): Promise<NormalizedSearchResponse>;
}

/**
 * Loose view of a provider's raw result entry. Only the whitelisted fields are
 * ever read; extra raw fields (including tokens/internal payloads) are never
 * copied into the normalized output.
 */
export interface RawSearchResult {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  rank?: unknown;
  date?: unknown;
  [key: string]: unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength) {
    throw new SearchProviderError("malformed_response");
  }
  return value;
}

function requireSafeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_RESULT_URL_LENGTH) {
    throw new SearchProviderError("dangerous_url");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SearchProviderError("dangerous_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SearchProviderError("dangerous_url");
  }
  return value;
}

function requireRank(value: unknown, seen: Set<number>, maxResults: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maxResults) {
    throw new SearchProviderError("malformed_response");
  }
  if (seen.has(value)) {
    throw new SearchProviderError("malformed_response");
  }
  seen.add(value);
  return value;
}

function requireDate(value: unknown): string {
  const date = requireString(value, "date", MAX_RESULT_DATE_LENGTH);
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) {
    throw new SearchProviderError("malformed_response");
  }
  return date;
}

/**
 * Normalizes a provider's raw result array into the contract shape. Strict:
 * missing/oversized fields, dangerous URLs, duplicate ranks and malformed
 * dates all fail with stable sanitized errors — never a lenient fallback that
 * could mask provider API drift.
 */
export function normalizeSearchResults(
  provider: string,
  rawResults: readonly RawSearchResult[],
  maxResults: number,
): NormalizedSearchResponse {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new SearchProviderError("invalid_request");
  }
  if (!Array.isArray(rawResults)) {
    throw new SearchProviderError("malformed_response");
  }
  const seenRanks = new Set<number>();
  const results: NormalizedSearchResult[] = [];
  const limit = Math.min(rawResults.length, maxResults);
  for (let index = 0; index < limit; index += 1) {
    const raw = rawResults[index];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new SearchProviderError("malformed_response");
    }
    const title = requireString(raw.title, "title", MAX_RESULT_TITLE_LENGTH);
    const url = requireSafeUrl(raw.url);
    const snippet = requireString(raw.snippet, "snippet", MAX_RESULT_SNIPPET_LENGTH);
    const rank = raw.rank === undefined ? index + 1 : requireRank(raw.rank, seenRanks, maxResults);
    const date = raw.date === undefined ? undefined : requireDate(raw.date);
    results.push({
      title,
      url,
      snippet,
      rank,
      provider,
      ...(date !== undefined ? { date } : {}),
    });
  }
  return { provider, results };
}
