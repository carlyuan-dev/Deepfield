import type { NormalizedSearchResult } from "../search-provider.js";
import type { QuerySetV1 } from "./queries.js";
import type { ReferenceSetV1 } from "./reference-companies.js";
import {
  computeCompletions,
  computeEligibility,
  isValidDangerousUrl,
  type BenchmarkedRun,
  type ProviderCompletion,
  type ProviderEligibility,
} from "./eligibility.js";
import { assertValidScoringInput, linkValidityFromEvidence } from "./input-validation.js";

export { assertValidScoringInput, linkValidityFromEvidence };

export { computeCompletions, computeEligibility, isValidDangerousUrl };
export type { BenchmarkedRun, ProviderCompletion, ProviderEligibility };

/** Fail-closed input validation: illegal measurements reject the whole benchmark. */
export class BenchmarkInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkInputError";
  }
}

export interface LinkEvidence {
  url: string;
  accessible: boolean;
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
  /** The fixed provider universe from the live selection (never inferred from runs). */
  expectedProviders: readonly string[];
  /** Expected runs per query (the plan fixes this at 2). */
  runsPerQuery: number;
  /** Per-provider per-URL accessibility evidence; scoring derives valid/total itself. */
  linkEvidence: Readonly<Record<string, readonly LinkEvidence[]>>;
  /** Providers whose link evidence is incomplete due to infrastructure failures. */
  linkCheckFailures?: readonly string[];
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
  /** All expected providers' raw measurements (partial data kept, marked incomplete). */
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
  const completions = computeCompletions({
    runs: input.runs,
    expectedProviders: input.expectedProviders,
    runsPerQuery: input.runsPerQuery,
    queries: input.queries,
    reference: input.reference,
  });
  const eligibility = computeEligibility({
    runs: input.runs,
    expectedProviders: input.expectedProviders,
    runsPerQuery: input.runsPerQuery,
    linkEvidence: input.linkEvidence,
    linkCheckFailures: input.linkCheckFailures ?? [],
    queries: input.queries,
    reference: input.reference,
  });
  const completedProviders = new Set(completions.filter((completion) => completion.completed).map((completion) => completion.provider));
  const gate: HardGateStatus = {
    fewerThanTwoCompleted: completedProviders.size < 2,
    noEligibleProvider: false,
  };

  const raw: ProviderRawMetrics[] = [];
  for (const provider of input.expectedProviders) {
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

    const { valid, total } = linkValidityFromEvidence(input.linkEvidence[provider] ?? []);
    const linkValidity = total === 0 ? 0 : valid / total;

    const urls = allResults.map((result) => result.url);
    const uniqueUrls = new Set(urls);
    const duplicateRate = urls.length === 0 ? 0 : 1 - uniqueUrls.size / urls.length;
    const noiseRate =
      allResults.length === 0
        ? 0
        : allResults.filter((result) => result.title.length === 0 && result.snippet.length === 0).length / allResults.length;

    const latencies = runs.map((run) => (Number.isFinite(run.latencyMs) && run.latencyMs >= 0 ? run.latencyMs : 0));
    const latencyP50Ms = percentile(latencies, 50);
    const latencyP95Ms = percentile(latencies, 95);
    const totalCostUsd = runs.reduce((sum, run) => sum + (Number.isFinite(run.costUsd) && run.costUsd >= 0 ? run.costUsd : 0), 0);

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
