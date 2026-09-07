import type { NormalizedSearchResponse } from "../search-provider.js";
import { SearchProviderError } from "../search-provider.js";
import type { SupportedProviderId } from "../providers/provider-catalog.js";
import { QUERIES_V1, type QuerySetV1 } from "./queries.js";
import { REFERENCE_COMPANIES_V1, type ReferenceSetV1 } from "./reference-companies.js";
import { scoreBenchmark, type BenchmarkedRun, type LinkEvidence } from "./scoring.js";
import { resolveProviderPricing, type ProviderPrice, type ResolvedProviderPricing } from "./pricing.js";
import type { BenchmarkReport } from "./report.js";

/** Narrow per-URL accessibility dependency; the live assembly reuses the accepted core. */
export interface LinkChecker {
  /** Per-URL evidence; MUST honor the caller's AbortSignal. */
  check(url: string, signal: AbortSignal): Promise<{ url: string; accessible: boolean }>;
}

export interface HarnessProvider {
  // offline harness is generic over SUPPORTED adapters; the live assembly
  // gates the actual v1 candidate set separately via requireBenchmarkCandidateAssembly
  id: SupportedProviderId;
  endpoint: string;
  search(query: string, maxResults: number, signal: AbortSignal): Promise<NormalizedSearchResponse>;
}

export interface BenchmarkHarnessDeps {
  providers: readonly HarnessProvider[];
  queries?: QuerySetV1;
  reference?: ReferenceSetV1;
  runsPerQuery: number;
  maxResults: number;
  linkChecker: LinkChecker;
  /** Native-currency price evidence per provider (never contains keys). */
  pricing: Readonly<Record<string, ProviderPrice>>;
  /** Atomic checkpoint writer (called after EVERY attempted measurement). */
  writer: (report: BenchmarkReport) => void;
  signal?: AbortSignal;
}

/** Fail-closed input validation: illegal measurements reject the whole benchmark. */
export class BenchmarkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkInputError";
  }
}

const PROVIDER_FAILURE_CODES: Partial<Record<string, string>> = {
  unauthorized: "provider_unauthorized",
  rate_limited: "provider_rate_limited",
  provider_unavailable: "provider_unavailable",
  timeout: "provider_timeout",
  cancelled: "provider_cancelled",
  response_too_large: "provider_response_too_large",
  malformed_response: "provider_malformed_response",
  redirect_blocked: "provider_redirect_blocked",
  network_unavailable: "provider_network_failure",
  dangerous_url: "provider_dangerous_url",
  invalid_request: "provider_invalid_request",
};

/**
 * Hard bound on concurrent destination-link checks WITHIN one measurement's
 * batch: maxResults is capped at 20, so one measurement can discover at most
 * 20 fresh urls; checking them in a single bounded batch (<= this constant)
 * instead of serially keeps one measurement worst case ~ 20s provider search
 * + one 30s link batch instead of 20 x 30s serial batches. Provider searches
 * across measurements stay strictly serial; this never raises provider call
 * counts and never retries.
 */
export const MAX_LINK_CHECK_CONCURRENCY = 20;

/** Stable sanitized failure label: never raw provider messages, queries, urls or keys. */
function failureLabel(error: unknown): string {
  if (error instanceof SearchProviderError) {
    return PROVIDER_FAILURE_CODES[error.code] ?? "provider_failed";
  }
  return "provider_failed";
}

/**
 * Offline-testable benchmark harness: the exact loop/counting/checkpoint state
 * machine the live benchmark runs, with injectable providers, link checker and
 * writer. expectedMeasurements is FIXED before any request; attempted
 * increments on success AND failure; a checkpoint is written after every
 * measurement. Each unique normalized URL is checked exactly ONCE per
 * benchmark (global cache); per-provider link evidence is projected from the
 * cache. Provider completion/eligibility only ever uses successful complete
 * runs and every expected provider (even with zero runs) stays visible.
 */
export async function runBenchmark(deps: BenchmarkHarnessDeps): Promise<BenchmarkReport> {
  const queries = deps.queries ?? { version: "v1", queries: QUERIES_V1 };
  const reference = deps.reference ?? { version: "v1", companies: REFERENCE_COMPANIES_V1 };
  if (!Number.isInteger(deps.runsPerQuery) || deps.runsPerQuery <= 0) {
    throw new BenchmarkInputError("invalid runsPerQuery");
  }
  if (!Number.isInteger(deps.maxResults) || deps.maxResults <= 0 || deps.maxResults > 20) {
    throw new BenchmarkInputError("invalid maxResults");
  }
  if (deps.providers.length < 2) {
    throw new BenchmarkInputError("at least two providers required");
  }
  const expectedProviders = deps.providers.map((provider) => provider.id);
  let resolvedPricing: ResolvedProviderPricing;
  try {
    resolvedPricing = resolveProviderPricing(deps.pricing, expectedProviders); // fail-closed before any request
  } catch {
    // stable sanitized label: no attached cause, no record/url/secret details
    throw new BenchmarkInputError("invalid pricing");
  }
  const pricingUsd = resolvedPricing.usdPerRequest;

  // FIXED before any request: never grows with progress
  const expectedMeasurements = deps.providers.length * queries.queries.length * deps.runsPerQuery;
  const failures: string[] = [];
  const runs: BenchmarkedRun[] = [];
  const linkCache = new Map<string, boolean>(); // global: outcome is provider-independent
  const linkCheckFailures = new Set<string>(); // providers with infra link-check errors
  let attempted = 0;
  let interrupted = false;

  const currentEvidence = (provider: string): readonly LinkEvidence[] => {
    const urls = [...new Set(runs.filter((run) => run.provider === provider).flatMap((run) => run.results.map((result) => result.url)))];
    // ONLY real cached outcomes: an unchecked URL is never fabricated as
    // accessible=false. Another provider may later check it and the global
    // cache then projects the genuine outcome.
    return urls.filter((url) => linkCache.has(url)).map((url) => ({ url, accessible: linkCache.get(url)! }));
  };

  const buildReport = (benchmarkComplete: boolean): BenchmarkReport => {
    const linkEvidence: Record<string, readonly LinkEvidence[]> = {};
    for (const provider of expectedProviders) {
      linkEvidence[provider] = currentEvidence(provider);
    }
    const scored = scoreBenchmark({
      runs,
      expectedProviders,
      runsPerQuery: deps.runsPerQuery,
      linkEvidence,
      linkCheckFailures: [...linkCheckFailures],
      queries,
      reference,
    });
    return {
      querySetVersion: queries.version,
      referenceSetVersion: reference.version,
      generatedAt: new Date().toISOString(),
      providerConfig: deps.providers.map((provider) => ({
        provider: provider.id,
        endpoint: provider.endpoint,
        maxResults: deps.maxResults,
        runsPerQuery: deps.runsPerQuery,
      })),
      failures: [...failures],
      runs: [...runs],
      expectedMeasurements,
      attemptedMeasurements: attempted,
      successfulMeasurements: runs.length,
      benchmarkComplete,
      pricing: { ...resolvedPricing.records },
      linkEvidence,
      linkCheckFailures: [...linkCheckFailures],
      completions: scored.completions,
      eligibility: scored.eligibility,
      raw: scored.raw,
      scores: scored.providers,
      hardGatePassed: benchmarkComplete && scored.hardGatePassed,
      hardGates: scored.hardGates,
    };
  };

  /**
   * One bounded concurrent batch over this measurement's FRESH (uncached)
   * urls. Workers launch up to min(20, freshCount) checks at once; every
   * started check settles (observed via Promise.all, so no unhandled
   * rejection). Resolution order never influences output: outcomes land in
   * the global cache and evidence is projected later in first-seen run order.
   * Abort stops new launches and, once in-flight checks settle, returns.
   * An unexpected infrastructure error records ONE stable sanitized failure
   * for the provider, stops new launches, but lets already-started checks
   * settle so no promise is left unobserved.
   */
  const checkNewUrls = async (provider: string, urls: readonly string[]): Promise<void> => {
    const fresh: string[] = [];
    const seen = new Set<string>();
    for (const url of urls) {
      if (!linkCache.has(url) && !seen.has(url)) {
        seen.add(url);
        fresh.push(url);
      }
    }
    if (fresh.length === 0) {
      return;
    }
    let nextIndex = 0;
    let stop = false;
    const recordInfraFailure = (): void => {
      if (!linkCheckFailures.has(provider)) {
        failures.push(`${provider}: link_check_failed`); // stable sanitized; once per provider
        linkCheckFailures.add(provider);
      }
    };
    const checkOne = async (url: string): Promise<void> => {
      try {
        const outcome = await deps.linkChecker.check(url, deps.signal ?? new AbortController().signal);
        if (outcome.url !== url) {
          throw new Error("link checker url mismatch");
        }
        linkCache.set(url, outcome.accessible);
      } catch (error) {
        if (deps.signal?.aborted || (error instanceof SearchProviderError && error.code === "cancelled")) {
          stop = true; // cancellation: stop silently; the outer loop marks incomplete
          return;
        }
        recordInfraFailure();
        stop = true; // do not launch remaining urls for this provider this batch
      }
    };
    const workers = Array.from({ length: Math.min(MAX_LINK_CHECK_CONCURRENCY, fresh.length) }, async () => {
      for (;;) {
        if (stop || deps.signal?.aborted) {
          return;
        }
        const index = nextIndex;
        nextIndex += 1;
        if (index >= fresh.length) {
          return;
        }
        await checkOne(fresh[index]!);
      }
    });
    await Promise.all(workers); // every started check settles here
  };

  outer: for (const provider of deps.providers) {
    for (const query of queries.queries) {
      for (let round = 0; round < deps.runsPerQuery; round += 1) {
        if (deps.signal?.aborted) {
          interrupted = true;
          break outer;
        }
        const startedAt = performance.now();
        try {
          const response = await provider.search(query.query, deps.maxResults, deps.signal ?? new AbortController().signal);
          if (deps.signal?.aborted) {
            interrupted = true;
            break outer; // cancelled while searching: keep no partial measurement
          }
          await checkNewUrls(provider.id, response.results.map((result) => result.url));
          if (deps.signal?.aborted) {
            interrupted = true;
            break outer; // cancelled mid-link-check: the run is not recorded (evidence incomplete)
          }
          runs.push({
            provider: provider.id,
            queryId: query.id,
            query: query.query,
            round,
            results: response.results,
            latencyMs: performance.now() - startedAt,
            costUsd: pricingUsd[provider.id]!,
          });
        } catch (error) {
          if (deps.signal?.aborted) {
            interrupted = true;
            break outer;
          }
          failures.push(`${provider.id}/${query.id}/run${round}: ${failureLabel(error)}`);
        }
        attempted += 1;
        deps.writer(buildReport(false));
      }
    }
  }
  const complete = !interrupted && attempted === expectedMeasurements;
  const finalReport = buildReport(complete);
  deps.writer(finalReport);
  return finalReport;
}
