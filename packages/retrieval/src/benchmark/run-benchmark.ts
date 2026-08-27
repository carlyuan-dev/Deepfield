import type { NormalizedSearchResponse } from "../search-provider.js";
import type { LiveProviderId } from "../providers/live-config.js";
import { QUERIES_V1, type QuerySetV1 } from "./queries.js";
import { REFERENCE_COMPANIES_V1, type ReferenceSetV1 } from "./reference-companies.js";
import { scoreBenchmark, type BenchmarkedRun, type LinkValiditySample } from "./scoring.js";
import type { BenchmarkReport } from "./report.js";

/** Narrow link-accessibility dependency; the live assembly reuses the accepted URL chain. */
export interface LinkChecker {
  /** Checks the EXACT deduplicated URL set; total must equal the set size. */
  check(urls: readonly string[]): Promise<LinkValiditySample>;
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
  /** Per-request USD per provider (Task-9-confirmed pricing; never contains keys). */
  pricingUsd: Readonly<Record<string, number>>;
  pricingNote: string;
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

function requireProviderPrice(price: unknown, provider: string): number {
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
    throw new BenchmarkInputError(`invalid pricing for ${provider}: must be a finite non-negative number`);
  }
  return price;
}

async function updateLinkValidity(
  provider: string,
  runs: readonly BenchmarkedRun[],
  checker: LinkChecker,
  linkValidity: Record<string, LinkValiditySample>,
  failures: string[],
): Promise<void> {
  const urls = [...new Set(runs.filter((run) => run.provider === provider).flatMap((run) => run.results.map((result) => result.url)))];
  if (urls.length === 0) {
    return;
  }
  const sample = await checker.check(urls);
  const legal =
    typeof sample === "object" &&
    sample !== null &&
    Number.isInteger(sample.total) &&
    sample.total >= 0 &&
    sample.total === urls.length &&
    Number.isInteger(sample.valid) &&
    sample.valid >= 0 &&
    sample.valid <= sample.total;
  if (!legal) {
    failures.push(`${provider}: link check sample invalid (expected total=${urls.length}, got total=${(sample as LinkValiditySample | undefined)?.total ?? "none"})`);
    linkValidity[provider] = { valid: 0, total: 0 }; // never eligible via a mismatched denominator
    return;
  }
  linkValidity[provider] = sample;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message;
}

/**
 * Offline-testable benchmark harness: the exact loop/counting/checkpoint state
 * machine the live benchmark runs, with injectable providers, link checker and
 * writer. expectedMeasurements is FIXED before any request; attempted
 * increments on success AND failure; a checkpoint is written after every
 * measurement so an interrupt keeps everything recorded (benchmarkComplete
 * stays false). Provider completion/eligibility only ever uses successful
 * complete runs.
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
  const pricingUsd: Record<string, number> = {};
  for (const provider of deps.providers) {
    pricingUsd[provider.id] = requireProviderPrice(deps.pricingUsd[provider.id], provider.id);
  }

  // FIXED before any request: never grows with progress
  const expectedMeasurements = deps.providers.length * queries.queries.length * deps.runsPerQuery;
  const failures: string[] = [];
  const runs: BenchmarkedRun[] = [];
  const linkValidity: Record<string, LinkValiditySample> = {};
  let attempted = 0;
  let interrupted = false;

  const buildReport = (benchmarkComplete: boolean): BenchmarkReport => {
    const scored = scoreBenchmark({ runs, runsPerQuery: deps.runsPerQuery, linkValidity, queries, reference });
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
      pricingUsd: { ...pricingUsd },
      pricingNote: deps.pricingNote,
      completions: scored.completions,
      eligibility: scored.eligibility,
      scores: scored.providers,
      hardGatePassed: benchmarkComplete && scored.hardGatePassed,
      hardGates: scored.hardGates,
    };
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
        } catch (error) {
          failures.push(`${provider.id}/${query.id}/run${round}: ${sanitizeError(error)}`);
        }
        attempted += 1;
        await updateLinkValidity(provider.id, runs, deps.linkChecker, linkValidity, failures);
        deps.writer(buildReport(false));
      }
    }
  }
  const complete = !interrupted && attempted === expectedMeasurements;
  const finalReport = buildReport(complete);
  deps.writer(finalReport);
  return finalReport;
}
