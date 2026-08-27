import type { NormalizedSearchResult } from "../search-provider.js";
import type { QuerySetV1 } from "./queries.js";
import type { ReferenceSetV1 } from "./reference-companies.js";

export const WEIGHTS = {
  companyRecall: 0.35,
  chineseOfficialCoverage: 0.25,
  linkValidity: 0.2,
  noiseAndDuplicates: 0.1,
  cost: 0.05,
  latency: 0.05,
} as const;

export interface BenchmarkedRun {
  provider: string;
  queryId: string;
  query: string;
  results: readonly NormalizedSearchResult[];
  latencyMs: number;
  costUsd: number;
}

export interface LinkValiditySample {
  valid: number;
  total: number;
}

export interface BenchmarkScoringInput {
  runs: readonly BenchmarkedRun[];
  /** Per-provider link validity samples (valid/total denominator). */
  linkValidity: Readonly<Record<string, LinkValiditySample>>;
  queries: QuerySetV1;
  reference: ReferenceSetV1;
}

export interface ProviderRawMetrics {
  provider: string;
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

export interface ProviderScore extends ProviderRawMetrics {
  noiseAndDuplicatesScore: number;
  costScore: number;
  latencyScore: number;
  weightedTotal: number;
}

export interface HardGateStatus {
  fewerThanTwoProviders: boolean;
  linkValidityBelow95: boolean;
  chineseEmpty: boolean;
  dangerousUrl: boolean;
  categoryMissing: boolean;
}

export interface BenchmarkScoringResult {
  providers: ProviderScore[];
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
 * normalized scores; a missing provider run is never silently imputed.
 */
export function scoreBenchmark(input: BenchmarkScoringInput): BenchmarkScoringResult {
  const providers = [...new Set(input.runs.map((run) => run.provider))];
  const chineseQueryIds = new Set(
    input.queries.queries
      .filter((query) => /[\u4e00-\u9fff]/.test(query.query))
      .map((query) => query.id),
  );
  const gate: HardGateStatus = {
    fewerThanTwoProviders: providers.length < 2,
    linkValidityBelow95: false,
    chineseEmpty: false,
    dangerousUrl: false,
    categoryMissing: false,
  };

  const scores: ProviderScore[] = [];
  for (const provider of providers) {
    const runs = input.runs.filter((run) => run.provider === provider);
    const allResults = runs.flatMap((run) => [...run.results]);

    // dangerous URL hard gate (raw data can contain one even though the
    // normalization layer would reject it)
    if (allResults.some((result) => {
      try {
        const url = new URL(result.url);
        return url.protocol !== "http:" && url.protocol !== "https:";
      } catch {
        return true;
      }
    })) {
      gate.dangerousUrl = true;
    }

    // company recall: fraction of reference companies with a domain match
    const matched = new Set<string>();
    for (const company of input.reference.companies) {
      if (allResults.some((result) => matchesCompanyDomain(result.url, company.domains))) {
        matched.add(company.id);
      }
    }
    const companyRecall = input.reference.companies.length === 0 ? 0 : matched.size / input.reference.companies.length;

    // Chinese official-site coverage: Chinese companies matched in Chinese queries
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

    // Chinese queries must return valid results
    if (chineseRuns.length > 0 && chineseRuns.every((run) => run.results.length === 0)) {
      gate.chineseEmpty = true;
    }

    // link validity with the explicit denominator; missing sample -> 0 (never imputed)
    const validity = input.linkValidity[provider];
    const linkValidity = validity === undefined || validity.total === 0 ? 0 : validity.valid / validity.total;
    if (linkValidity < 0.95) {
      gate.linkValidityBelow95 = true;
    }

    // noise + duplicates: duplicate URL rate and empty-snippet noise rate
    const urls = allResults.map((result) => result.url);
    const uniqueUrls = new Set(urls);
    const duplicateRate = urls.length === 0 ? 0 : 1 - uniqueUrls.size / urls.length;
    const noiseRate =
      allResults.length === 0
        ? 0
        : allResults.filter((result) => result.title.length === 0 && result.snippet.length === 0).length / allResults.length;
    const noiseAndDuplicatesScore = 1 - 0.5 * duplicateRate - 0.5 * noiseRate;

    // latency p50/p95 from raw run latencies
    const latencies = runs.map((run) => run.latencyMs);
    const latencyP50Ms = percentile(latencies, 50);
    const latencyP95Ms = percentile(latencies, 95);

    // raw metrics separated from scores
    const raw: ProviderRawMetrics = {
      provider,
      runsCompleted: runs.length,
      companyRecall,
      chineseOfficialCoverage,
      linkValidity,
      duplicateRate,
      noiseRate,
      latencyP50Ms,
      latencyP95Ms,
      totalCostUsd: runs.reduce((sum, run) => sum + run.costUsd, 0),
    };
    scores.push({
      ...raw,
      noiseAndDuplicatesScore,
      costScore: 0, // filled after normalization across providers
      latencyScore: 0,
      weightedTotal: 0,
    });
  }

  // cost/latency scores normalized across the COMPLETED providers
  const totalCosts = scores.map((score) => score.totalCostUsd).filter((cost) => cost >= 0);
  const minCost = totalCosts.length === 0 ? 0 : Math.min(...totalCosts);
  const maxCost = totalCosts.length === 0 ? 0 : Math.max(...totalCosts);
  const p50s = scores.map((score) => score.latencyP50Ms).filter((v) => v > 0);
  const minP50 = p50s.length === 0 ? 0 : Math.min(...p50s);

  for (const score of scores) {
    score.costScore = maxCost === 0 ? 1 : minCost === maxCost ? 1 : 1 - (score.totalCostUsd - minCost) / (maxCost - minCost);
    score.latencyScore = minP50 === 0 || score.latencyP50Ms === 0 ? 0 : minP50 / score.latencyP50Ms;
    score.weightedTotal =
      WEIGHTS.companyRecall * score.companyRecall +
      WEIGHTS.chineseOfficialCoverage * score.chineseOfficialCoverage +
      WEIGHTS.linkValidity * score.linkValidity +
      WEIGHTS.noiseAndDuplicates * score.noiseAndDuplicatesScore +
      WEIGHTS.cost * score.costScore +
      WEIGHTS.latency * score.latencyScore;
  }

  // systematic category missing: a provider matches NO company of a category
  for (const score of scores) {
    const providerRuns = input.runs.filter((run) => run.provider === score.provider);
    const providerResults = providerRuns.flatMap((run) => [...run.results]);
    for (const category of ["chinese", "overseas"] as const) {
      const companies = input.reference.companies.filter((company) => company.category === category);
      const anyMatched = companies.some((company) =>
        providerResults.some((result) => matchesCompanyDomain(result.url, company.domains)),
      );
      if (companies.length > 0 && !anyMatched) {
        gate.categoryMissing = true;
      }
    }
  }

  const hardGatePassed = !Object.values(gate).some(Boolean);
  return { providers: scores, raw: scores.map(({ provider, runsCompleted, companyRecall, chineseOfficialCoverage, linkValidity, duplicateRate, noiseRate, latencyP50Ms, latencyP95Ms, totalCostUsd }) => ({
    provider, runsCompleted, companyRecall, chineseOfficialCoverage, linkValidity, duplicateRate, noiseRate, latencyP50Ms, latencyP95Ms, totalCostUsd,
  })), hardGates: gate, hardGatePassed };
}
