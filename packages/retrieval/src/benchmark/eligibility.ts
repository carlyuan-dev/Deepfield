import type { NormalizedSearchResult } from "../search-provider.js";
import type { QuerySetV1 } from "./queries.js";
import type { ReferenceSetV1 } from "./reference-companies.js";
import { matchesCompanyDomain } from "./scoring.js";

export interface BenchmarkedRun {
  provider: string;
  queryId: string;
  query: string;
  /** Round identity within the query (0-based); completion requires 0..runsPerQuery-1 each exactly once. */
  round: number;
  results: readonly NormalizedSearchResult[];
  latencyMs: number;
  costUsd: number;
}

export interface LinkValiditySample {
  valid: number;
  total: number;
}

export interface ProviderCompletion {
  provider: string;
  completed: boolean;
  runCount: number;
  expectedCount: number;
  missing: string[];
  duplicateRounds: string[];
  unknownQueries: string[];
}

export interface ProviderEligibility {
  provider: string;
  eligible: boolean;
  reasons: string[];
}

export interface EligibilityInput {
  runs: readonly BenchmarkedRun[];
  runsPerQuery: number;
  linkValidity: Readonly<Record<string, LinkValiditySample>>;
  queries: QuerySetV1;
  reference: ReferenceSetV1;
}

/**
 * Deterministic run-set completion: a provider is complete ONLY when every
 * query id appears exactly runsPerQuery times with unique valid rounds and no
 * unknown queries. Partial data is never silently imputed.
 */
export function computeCompletions(input: EligibilityInput): ProviderCompletion[] {
  const queryIds = input.queries.queries.map((query) => query.id);
  const queryById = new Map(input.queries.queries.map((query) => [query.id, query]));
  const providers = [...new Set(input.runs.map((run) => run.provider))];
  return providers.map((provider) => {
    const providerRuns = input.runs.filter((run) => run.provider === provider);
    const roundsByQuery = new Map<string, number[]>();
    const unknownQueries: string[] = [];
    for (const run of providerRuns) {
      if (!queryById.has(run.queryId)) {
        unknownQueries.push(run.queryId);
        continue;
      }
      const rounds = roundsByQuery.get(run.queryId) ?? [];
      rounds.push(run.round);
      roundsByQuery.set(run.queryId, rounds);
    }
    const missing: string[] = [];
    const duplicateRounds: string[] = [];
    for (const queryId of queryIds) {
      const rounds = roundsByQuery.get(queryId) ?? [];
      if (rounds.length === 0) {
        missing.push(queryId);
        continue;
      }
      const counts = new Map<number, number>();
      let badRound = false;
      for (const round of rounds) {
        if (!Number.isInteger(round) || round < 0 || round >= input.runsPerQuery) {
          badRound = true;
        } else {
          counts.set(round, (counts.get(round) ?? 0) + 1);
        }
      }
      if (badRound) {
        duplicateRounds.push(`${queryId}:bad-round`);
      }
      for (const [round, count] of counts) {
        if (count > 1) {
          duplicateRounds.push(`${queryId}:${round}`);
        }
      }
      if (rounds.length !== input.runsPerQuery) {
        duplicateRounds.push(`${queryId}:count=${rounds.length}`);
      }
    }
    const completed =
      unknownQueries.length === 0 &&
      missing.length === 0 &&
      duplicateRounds.length === 0 &&
      providerRuns.length === queryIds.length * input.runsPerQuery;
    return {
      provider,
      completed,
      runCount: providerRuns.length,
      expectedCount: queryIds.length * input.runsPerQuery,
      missing,
      duplicateRounds,
      unknownQueries,
    };
  });
}

function requireFiniteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0; // invalid measurements never produce NaN/Infinity/negative scores
  }
  return value;
}

export function isValidDangerousUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol !== "http:" && parsed.protocol !== "https:";
  } catch {
    return true;
  }
}

/**
 * Per-provider eligibility: a provider is eligible only when its run set is
 * complete AND it passes its own hard gates (link validity, Chinese query
 * results, dangerous URLs, systematic category coverage). One bad provider
 * never poisons another.
 */
export function computeEligibility(input: EligibilityInput): ProviderEligibility[] {
  const completions = computeCompletions(input);
  const queryIds = input.queries.queries.map((query) => query.id);
  const queryById = new Map(input.queries.queries.map((query) => [query.id, query]));
  const chineseQueryIds = new Set(
    input.queries.queries
      .filter((query) => /[\u4e00-\u9fff]/.test(query.query))
      .map((query) => query.id),
  );
  const providers = [...new Set(input.runs.map((run) => run.provider))];
  return providers.map((provider) => {
    const completion = completions.find((entry) => entry.provider === provider)!;
    const runs = input.runs.filter((run) => run.provider === provider);
    const allResults = runs.flatMap((run) => [...run.results]);
    const reasons: string[] = [];

    if (allResults.some((result) => isValidDangerousUrl(result.url))) {
      reasons.push("dangerous url");
    }

    const chineseRuns = runs.filter((run) => chineseQueryIds.has(run.queryId));
    if (chineseRuns.length > 0 && chineseRuns.every((run) => run.results.length === 0)) {
      reasons.push("chinese queries empty");
    }

    const validity = input.linkValidity[provider];
    let linkValidity = 0;
    if (validity !== undefined) {
      const total = requireFiniteNonNegative(validity.total, "linkValidity.total");
      const valid = requireFiniteNonNegative(validity.valid, "linkValidity.valid");
      if (valid > total) {
        linkValidity = 0; // illegal denominator: never a value above 1
      } else {
        linkValidity = total === 0 ? 0 : valid / total;
      }
    }
    if (linkValidity < 0.95) {
      reasons.push("link validity below 0.95");
    }

    for (const category of ["chinese", "overseas"] as const) {
      const companies = input.reference.companies.filter((company) => company.category === category);
      const anyMatched = companies.some((company) =>
        allResults.some((result) => matchesCompanyDomain(result.url, company.domains)),
      );
      if (companies.length > 0 && !anyMatched) {
        reasons.push(`category missing: ${category}`);
      }
    }

    if (!completion.completed && reasons.length === 0) {
      reasons.push("incomplete run set");
    }
    return { provider, eligible: completion.completed && reasons.length === 0, reasons };
  });
}
