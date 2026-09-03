import type { NormalizedSearchResponse } from "../search-provider.js";
import { SearchProviderError } from "../search-provider.js";
import type { LiveProviderId } from "../providers/live-config.js";
import { QUERIES_V1, type QuerySetV1 } from "./queries.js";
import { REFERENCE_COMPANIES_V1, type ReferenceSetV1 } from "./reference-companies.js";
import { scoreBenchmark, type BenchmarkedRun, type LinkEvidence } from "./scoring.js";
import { resolveProviderPricing, type ProviderPrice } from "./pricing.js";
import type { BenchmarkReport } from "./report.js";

/** Narrow per-URL accessibility dependency; the live assembly reuses the accepted core. */
export interface LinkChecker {
  /** Per-URL evidence; MUST honor the caller's AbortSignal. */
  check(url: string, signal: AbortSignal): Promise<{ url: string; accessible: boolean }>;
}

export interface HarnessProvider {
  id: LiveProviderId;
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
  const resolvedPricing = resolveProviderPricing(deps.pricing, expectedProviders); // fail-closed before any request
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

  const checkNewUrls = async (provider: string, urls: readonly string[]): Promise<void> => {
    for (const url of urls) {
      if (deps.signal?.aborted) {
        return; // abort stops remaining link checks; the outer loop marks incomplete
      }
      if (linkCache.has(url)) {
        continue; // already checked (possibly by another provider): reuse the outcome
      }
      try {
        const outcome = await deps.linkChecker.check(url, deps.signal ?? new AbortController().signal);
        if (outcome.url !== url) {
          throw new Error("link checker url mismatch");
        }
        linkCache.set(url, outcome.accessible);
      } catch (error) {
        if (deps.signal?.aborted || (error instanceof SearchProviderError && error.code === "cancelled")) {
          return; // cancellation: stop silently; benchmarkComplete stays false
        }
        failures.push(`${provider}: link_check_failed`); // stable sanitized
        linkCheckFailures.add(provider);
        return; // do not continue checking remaining urls for this provider
      }
    }
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
          runs.push({
            provider: provider.id,
            queryId: query.id,
            query: query.query,
            round,
            results: response.results,
            latencyMs: performance.now() - startedAt,
            costUsd: pricingUsd[provider.id]!,
          });
          await checkNewUrls(provider.id, response.results.map((result) => result.url));
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
