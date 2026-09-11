export const MAX_QUERY_LENGTH = 512;
export const MAX_RESULTS = 20;
export const MAX_RESULT_URL_LENGTH = 2048;
export const MAX_RESULT_TITLE_LENGTH = 2000;
export const MAX_RESULT_SNIPPET_LENGTH = 8000;
export const MAX_RESULT_DATE_LENGTH = 10;
export const MAX_PROVIDER_ID_LENGTH = 64;

export interface SearchRequest {
  query: string;
  /** 1..20 — enforced by the contract and the tool schema. */
  maxResults: number;
  /** Optional YYYY-MM-DD time range (from <= to, inclusive). */
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
  /** Optional YYYY-MM-DD date. */
  date?: string;
  publishedAt?: string;
  sourceName?: string;
}

export interface NormalizedSearchResponse {
  provider: string;
  results: NormalizedSearchResult[];
}

/** A provider adapter: fixed endpoint, normalized output, sanitized errors. */
export interface SearchProvider {
  readonly id: string;
  /** Explicit capability declaration; a provider that lacks it rejects timeRange. */
  readonly capabilities: { timeRange: boolean };
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
  publishedAt?: unknown;
  sourceName?: unknown;
  [key: string]: unknown;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Real calendar validation for YYYY-MM-DD (leap years, month ends). */
export function isValidDateString(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]!);
  const month = Number(match[2]!);
  const day = Number(match[3]!);
  if (month < 1 || month > 12) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

/**
 * Validates a normalized request at the contract boundary. The tool and every
 * adapter call this before touching the network so an illegal time range or
 * query never reaches a remote provider.
 */
export function assertValidSearchRequest(request: SearchRequest): void {
  if (
    typeof request.query !== "string" ||
    request.query.trim().length === 0 || // whitespace-only queries are rejected
    request.query.length > MAX_QUERY_LENGTH
  ) {
    throw new SearchProviderError("invalid_request");
  }
  if (
    !Number.isInteger(request.maxResults) ||
    request.maxResults < 1 ||
    request.maxResults > MAX_RESULTS
  ) {
    throw new SearchProviderError("invalid_request");
  }
  if (request.timeRange !== undefined) {
    const { from, to } = request.timeRange;
    if (
      typeof from !== "string" ||
      typeof to !== "string" ||
      !isValidDateString(from) ||
      !isValidDateString(to) ||
      from > to // YYYY-MM-DD compares lexicographically
    ) {
      throw new SearchProviderError("invalid_request");
    }
  }
}

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
  // percent-encoding can expand non-ASCII input beyond the bound: re-check the
  // NORMALIZED href; the output is the full verified parsed href, never a
  // truncated or raw-unvalidated value
  if (parsed.href.length > MAX_RESULT_URL_LENGTH) {
    throw new SearchProviderError("dangerous_url");
  }
  return parsed.href;
}

function requireDate(value: unknown): string {
  const date = requireString(value, "date", MAX_RESULT_DATE_LENGTH);
  if (!isValidDateString(date)) {
    throw new SearchProviderError("malformed_response");
  }
  return date;
}

/**
 * Normalizes a provider's raw result array into the contract shape. Strict:
 * missing/oversized fields, dangerous URLs, duplicate ranks (implicit or
 * explicit) and malformed dates all fail with stable sanitized errors — never
 * a lenient fallback that could mask provider API drift.
 */
export function normalizeSearchResults(
  provider: string,
  rawResults: readonly RawSearchResult[],
  maxResults: number,
): NormalizedSearchResponse {
  if (typeof provider !== "string" || provider.length === 0 || provider.length > MAX_PROVIDER_ID_LENGTH) {
    throw new SearchProviderError("invalid_request");
  }
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
    // EVERY rank — implicit (index+1) or explicit — goes through the same
    // uniqueness check, so mixed implicit/explicit duplicates are rejected.
    const explicitRank = raw.rank;
    const rank =
      explicitRank === undefined
        ? index + 1
        : (() => {
            if (typeof explicitRank !== "number" || !Number.isInteger(explicitRank) || explicitRank < 1 || explicitRank > maxResults) {
              throw new SearchProviderError("malformed_response");
            }
            return explicitRank;
          })();
    if (seenRanks.has(rank)) {
      throw new SearchProviderError("malformed_response");
    }
    seenRanks.add(rank);
    const date = raw.date === undefined ? undefined : requireDate(raw.date);
    const publishedAt = raw.publishedAt === undefined ? undefined : requireDate(raw.publishedAt);
    const sourceName = raw.sourceName === undefined
      ? undefined
      : requireString(raw.sourceName, "sourceName", MAX_RESULT_TITLE_LENGTH);
    results.push({
      title,
      url,
      snippet,
      rank,
      provider,
      ...(date !== undefined ? { date } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(sourceName !== undefined ? { sourceName } : {}),
    });
  }
  return { provider, results };
}
