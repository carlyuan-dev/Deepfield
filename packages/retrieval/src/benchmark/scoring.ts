import type { NormalizedSearchResult } from "../search-provider.js";
import type { QuerySetV1 } from "./queries.js";
import type { ReferenceSetV1 } from "./reference-companies.js";
import {
  computeCompletions,
  computeEligibility,
  isValidDangerousUrl,
  type BenchmarkedRun,
  type LinkValiditySample,
  type ProviderCompletion,
  type ProviderEligibility,
} from "./eligibility.js";

export { computeCompletions, computeEligibility, isValidDangerousUrl };
export type { BenchmarkedRun, LinkValiditySample, ProviderCompletion, ProviderEligibility };

/** Fail-closed input validation: illegal measurements reject the whole benchmark. */
export class BenchmarkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkInputError";
  }
}

export const WEIGHTS = {
  companyRecall: 0.35,
  chineseOfficialCoverage: 0.25,
  linkValidity: 0.2,
  noiseAndDuplicates: 0.1,
  cost: 0.05,
  latency: 0.05,
} as const;

export interface BenchmarkScoringInput {
  runs: readonly BenchmarkedRun[];
  /** Expected runs per query (the plan fixes this at 2). */
  runsPerQuery: number;
  /** Per-provider link validity samples (valid/total denominator). */
  linkValidity: Readonly<Record<string, LinkValiditySample>>;
  queries: QuerySetV1;
  reference: ReferenceSetV1;
}

export interface ProviderRawMetrics {
  provider: string;
  completed: boolean;
  runsCompleted: number;
  companyRecall: number;
  chineseOfficialCoverage: number;
  linkValidity: number;
  duplicateRate: number;
  noiseRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  totalCostUsd: number;
}

export interface ProviderScore extends Omit<ProviderRawMetrics, "completed"> {
  noiseAndDuplicatesScore: number;
  costScore: number;
  latencyScore: number;
  weightedTotal: number;
}

export interface HardGateStatus {
  /** Benchmark-level gate: fewer than two providers COMPLETED the full set. */
  fewerThanTwoCompleted: boolean;
  /** No completed provider is eligible. */
  noEligibleProvider: boolean;
}

export interface BenchmarkScoringResult {
  /** Completed AND eligible providers with normalized scores. */
  providers: ProviderScore[];
  completions: ProviderCompletion[];
  eligibility: ProviderEligibility[];
  /** All providers' raw measurements (partial data kept, marked incomplete). */
  raw: ProviderRawMetrics[];
  hardGates: HardGateStatus;
  hardGatePassed: boolean;
}

/** Lowercases and strips the www. prefix for deterministic domain matching. */
export function normalizeDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

export function urlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function matchesCompanyDomain(url: string, domains: readonly string[]): boolean {
  const host = normalizeDomain(urlHostname(url));
  return domains.some((domain) => host === normalizeDomain(domain) || host.endsWith(`.${normalizeDomain(domain)}`));
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function requireFiniteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0; // invalid measurements never produce NaN/Infinity/negative scores
  }
  return value;
}

/**
 * Strict fail-closed input validation: any illegal measurement (non-finite,
 * negative, wrong integer type, mismatched query text, illegal link sample)
 * rejects the WHOLE benchmark before scoring — never clamped, interpolated or
 * rewarded.
 */
export function assertValidScoringInput(input: BenchmarkScoringInput): void {
  if (!Number.isInteger(input.runsPerQuery) || input.runsPerQuery <= 0) {
    throw new BenchmarkInputError("invalid runsPerQuery");
  }
  const queryById = new Map(input.queries.queries.map((query) => [query.id, query]));
  for (const run of input.runs) {
    if (typeof run.provider !== "string" || run.provider.length === 0 || run.provider.length > 64) {
      throw new BenchmarkInputError(`invalid provider in run ${run.queryId}`);
    }
    if (typeof run.queryId !== "string" || !queryById.has(run.queryId)) {
      throw new BenchmarkInputError(`unknown query id "${run.queryId}"`);
    }
    if (typeof run.query !== "string" || run.query !== queryById.get(run.queryId)!.query) {
      throw new BenchmarkInputError(`query text mismatch for ${run.queryId}`);
    }
    if (!Number.isInteger(run.round) || run.round < 0 || run.round >= input.runsPerQuery) {
      throw new BenchmarkInputError(`invalid round ${run.round} for ${run.queryId}`);
    }
    if (!Number.isFinite(run.latencyMs) || run.latencyMs < 0) {
      throw new BenchmarkInputError(`invalid latencyMs for ${run.queryId}`);
    }
    if (!Number.isFinite(run.costUsd) || run.costUsd < 0) {
      throw new BenchmarkInputError(`invalid costUsd for ${run.queryId}`);
    }
    if (!Array.isArray(run.results)) {
      throw new BenchmarkInputError(`invalid results for ${run.queryId}`);
    }
  }
  for (const [provider, sample] of Object.entries(input.linkValidity)) {
    if (
      typeof sample !== "object" ||
      sample === null ||
      !Number.isInteger(sample.total) ||
      sample.total < 0 ||
      !Number.isInteger(sample.valid) ||
      sample.valid < 0 ||
      sample.valid > sample.total
    ) {
      throw new BenchmarkInputError(`invalid link validity sample for ${provider}`);
    }
  }
}

/**
 * Deterministic offline scoring. Raw measured values are kept separate from
 * normalized scores; a missing/partial provider run is never silently
 * imputed. Only providers that COMPLETE every query exactly runsPerQuery
 * times (with unique rounds, no unknown queries) can be eligible; per-provider
 * hard gates (link validity, Chinese emptiness, dangerous URLs, category
 * coverage) decide eligibility without poisoning other providers.
 */
export function scoreBenchmark(input: BenchmarkScoringInput): BenchmarkScoringResult {
  assertValidScoringInput(input);
  const chineseQueryIds = new Set(
    input.queries.queries
      .filter((query) => /[\u4e00-\u9fff]/.test(query.query))
      .map((query) => query.id),
  );
  const providers = [...new Set(input.runs.map((run) => run.provider))];
  const completions = computeCompletions({ ...input, runs: input.runs });
  const eligibility = computeEligibility({ ...input, runs: input.runs });
  const completedProviders = new Set(completions.filter((completion) => completion.completed).map((completion) => completion.provider));
  const gate: HardGateStatus = {
    fewerThanTwoCompleted: completedProviders.size < 2,
    noEligibleProvider: false,
  };

  const raw: ProviderRawMetrics[] = [];
  for (const provider of providers) {
    const completion = completions.find((entry) => entry.provider === provider)!;
    const runs = input.runs.filter((run) => run.provider === provider);
    const allResults = runs.flatMap((run) => [...run.results]);

    const matched = new Set<string>();
    for (const company of input.reference.companies) {
      if (allResults.some((result) => matchesCompanyDomain(result.url, company.domains))) {
        matched.add(company.id);
      }
    }
    const companyRecall = input.reference.companies.length === 0 ? 0 : matched.size / input.reference.companies.length;

    const chineseCompanies = input.reference.companies.filter((company) => company.category === "chinese");
    const chineseRuns = runs.filter((run) => chineseQueryIds.has(run.queryId));
    const chineseResults = chineseRuns.flatMap((run) => [...run.results]);
    let chineseMatched = 0;
    for (const company of chineseCompanies) {
      if (chineseResults.some((result) => matchesCompanyDomain(result.url, company.domains))) {
        chineseMatched += 1;
      }
    }
    const chineseOfficialCoverage = chineseCompanies.length === 0 ? 0 : chineseMatched / chineseCompanies.length;

    const validity = input.linkValidity[provider];
    let linkValidity = 0;
    if (validity !== undefined) {
      const total = requireFiniteNonNegative(validity.total, "linkValidity.total");
      const valid = requireFiniteNonNegative(validity.valid, "linkValidity.valid");
      if (valid > total) {
        linkValidity = 0;
      } else {
        linkValidity = total === 0 ? 0 : valid / total;
      }
    }

    const urls = allResults.map((result) => result.url);
    const uniqueUrls = new Set(urls);
    const duplicateRate = urls.length === 0 ? 0 : 1 - uniqueUrls.size / urls.length;
    const noiseRate =
      allResults.length === 0
        ? 0
        : allResults.filter((result) => result.title.length === 0 && result.snippet.length === 0).length / allResults.length;

    const latencies = runs.map((run) => requireFiniteNonNegative(run.latencyMs, "latencyMs"));
    const latencyP50Ms = percentile(latencies, 50);
    const latencyP95Ms = percentile(latencies, 95);
    const totalCostUsd = runs.reduce((sum, run) => sum + requireFiniteNonNegative(run.costUsd, "costUsd"), 0);

    raw.push({
      provider,
      completed: completion.completed,
      runsCompleted: runs.length,
      companyRecall,
      chineseOfficialCoverage,
      linkValidity,
      duplicateRate,
      noiseRate,
      latencyP50Ms,
      latencyP95Ms,
      totalCostUsd,
    });
  }

  const eligibleProviders = eligibility.filter((entry) => entry.eligible).map((entry) => entry.provider);
  gate.noEligibleProvider = eligibleProviders.length === 0;

  const scores: ProviderScore[] = [];
  for (const provider of eligibleProviders) {
    const metrics = raw.find((entry) => entry.provider === provider)!;
    scores.push({
      ...metrics,
      noiseAndDuplicatesScore: 1 - 0.5 * metrics.duplicateRate - 0.5 * metrics.noiseRate,
      costScore: 0,
      latencyScore: 0,
      weightedTotal: 0,
    });
  }
  const totalCosts = scores.map((score) => score.totalCostUsd);
  const minCost = totalCosts.length === 0 ? 0 : Math.min(...totalCosts);
  const maxCost = totalCosts.length === 0 ? 0 : Math.max(...totalCosts);
  const p50s = scores.map((score) => score.latencyP50Ms).filter((value) => value > 0);
  const minP50 = p50s.length === 0 ? 0 : Math.min(...p50s);
  for (const score of scores) {
    score.costScore = maxCost === 0 ? 1 : minCost === maxCost ? 1 : 1 - (score.totalCostUsd - minCost) / (maxCost - minCost);
    score.latencyScore = minP50 === 0 || score.latencyP50Ms === 0 ? 0 : Math.min(1, minP50 / score.latencyP50Ms);
    score.weightedTotal =
      WEIGHTS.companyRecall * score.companyRecall +
      WEIGHTS.chineseOfficialCoverage * score.chineseOfficialCoverage +
      WEIGHTS.linkValidity * score.linkValidity +
      WEIGHTS.noiseAndDuplicates * score.noiseAndDuplicatesScore +
      WEIGHTS.cost * score.costScore +
      WEIGHTS.latency * score.latencyScore;
  }

  const hardGatePassed = !gate.fewerThanTwoCompleted && !gate.noEligibleProvider;
  return { providers: scores, completions, eligibility, raw, hardGates: gate, hardGatePassed };
}
