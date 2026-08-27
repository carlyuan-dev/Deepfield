import type { NormalizedSearchResult } from "../search-provider.js";
import type { QuerySetV1 } from "./queries.js";
import type { ReferenceSetV1 } from "./reference-companies.js";
import { matchesCompanyDomain, linkValidityFromEvidence, type LinkEvidence } from "./scoring.js";

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

export interface ProviderCompletion {
  provider: string;
  completed: boolean;
  runCount: number;
  expectedCount: number;
  missing: string[];
  duplicateRounds: string[];
  unknownQueries: string[];
  /** Runs whose queryId exists but whose query text differs from the frozen set. */
  queryTextMismatches: string[];
}

export interface ProviderEligibility {
  provider: string;
  eligible: boolean;
  reasons: string[];
}

export interface EligibilityInput {
  runs: readonly BenchmarkedRun[];
  expectedProviders: readonly string[];
  runsPerQuery: number;
  linkEvidence?: Readonly<Record<string, readonly LinkEvidence[]>>;
  linkCheckFailures?: readonly string[];
  queries: QuerySetV1;
  reference: ReferenceSetV1;
}

/**
 * Deterministic run-set completion over the FIXED provider universe: a
 * provider is complete ONLY when every query id appears exactly runsPerQuery
 * times with unique valid rounds and no unknown queries. Providers with zero
 * successful runs still appear (completed=false, missing=all). Partial data is
 * never silently imputed.
 */
export function computeCompletions(input: EligibilityInput): ProviderCompletion[] {
  const queryIds = input.queries.queries.map((query) => query.id);
  const queryById = new Map(input.queries.queries.map((query) => [query.id, query]));
  return input.expectedProviders.map((provider) => {
    const providerRuns = input.runs.filter((run) => run.provider === provider);
    const roundsByQuery = new Map<string, number[]>();
    const unknownQueries: string[] = [];
    const queryTextMismatches: string[] = [];
    for (const run of providerRuns) {
      const frozen = queryById.get(run.queryId);
      if (frozen === undefined) {
        unknownQueries.push(run.queryId);
        continue;
      }
      if (run.query !== frozen.query) {
        queryTextMismatches.push(`${run.queryId}:wrong-text`);
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
      queryTextMismatches.length === 0 &&
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
      queryTextMismatches,
    };
  });
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
 * Per-provider eligibility over the FIXED provider universe: a provider is
 * eligible only when its run set is complete AND it passes its own hard gates
 * (link validity, per-query Chinese results, dangerous URLs, systematic
 * category coverage, link-check infrastructure failures). One bad provider
 * never poisons another.
 */
export function computeEligibility(input: EligibilityInput): ProviderEligibility[] {
  const completions = computeCompletions(input);
  const chineseQueryIds = new Set(
    input.queries.queries
      .filter((query) => /[\u4e00-\u9fff]/.test(query.query))
      .map((query) => query.id),
  );
  const infraFailures = new Set(input.linkCheckFailures ?? []);
  return input.expectedProviders.map((provider) => {
    const completion = completions.find((entry) => entry.provider === provider)!;
    const runs = input.runs.filter((run) => run.provider === provider);
    const allResults = runs.flatMap((run) => [...run.results]);
    const reasons: string[] = [];

    if (allResults.some((result) => isValidDangerousUrl(result.url))) {
      reasons.push("dangerous url");
    }

    for (const queryId of chineseQueryIds) {
      const queryRuns = runs.filter((run) => run.queryId === queryId);
      if (queryRuns.length > 0 && queryRuns.every((run) => run.results.length === 0)) {
        reasons.push(`chinese query empty: ${queryId}`);
      }
    }

    const { valid, total } = linkValidityFromEvidence(input.linkEvidence?.[provider] ?? []);
    const linkValidity = total === 0 ? 0 : valid / total;
    if (linkValidity < 0.95) {
      reasons.push("link validity below 0.95");
    }
    if (infraFailures.has(provider)) {
      reasons.push("link check infrastructure failure");
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
