import type { BenchmarkedRun } from "./eligibility.js";
import { BenchmarkInputError, type BenchmarkScoringInput, type LinkEvidence } from "./scoring.js";

function uniqueResultUrls(runs: readonly BenchmarkedRun[], provider: string): string[] {
  return [...new Set(runs.filter((run) => run.provider === provider).flatMap((run) => run.results.map((result) => result.url)))];
}

/** Derives valid/total for a provider from its per-URL evidence (never hand-filled). */
export function linkValidityFromEvidence(evidence: readonly LinkEvidence[]): { valid: number; total: number } {
  const total = evidence.length;
  const valid = evidence.filter((entry) => entry.accessible === true).length;
  return { valid, total };
}

/**
 * Strict fail-closed input validation. The provider universe comes from
 * expectedProviders (never inferred from runs); every run must belong to it;
 * link evidence must match the deduplicated result URL set EXACTLY per
 * provider (no missing/duplicate/unknown urls, valid accessible booleans)
 * unless the provider is listed in linkCheckFailures. Any illegal measurement
 * rejects the WHOLE benchmark before scoring — never clamped, interpolated or
 * rewarded.
 */
export function assertValidScoringInput(input: BenchmarkScoringInput): void {
  if (!Number.isInteger(input.runsPerQuery) || input.runsPerQuery <= 0) {
    throw new BenchmarkInputError("invalid runsPerQuery");
  }
  if (!Array.isArray(input.expectedProviders) || input.expectedProviders.length === 0) {
    throw new BenchmarkInputError("expectedProviders must be a non-empty array");
  }
  const expectedSet = new Set<string>();
  for (const provider of input.expectedProviders) {
    if (typeof provider !== "string" || provider.length === 0 || provider.length > 64 || expectedSet.has(provider)) {
      throw new BenchmarkInputError(`invalid expectedProviders entry "${String(provider).slice(0, 20)}"`);
    }
    expectedSet.add(provider);
  }
  const queryById = new Map(input.queries.queries.map((query) => [query.id, query]));
  for (const run of input.runs) {
    if (typeof run.provider !== "string" || !expectedSet.has(run.provider)) {
      throw new BenchmarkInputError(`run provider "${run.provider}" outside expectedProviders`);
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
  const infraFailures = new Set(input.linkCheckFailures ?? []);
  const providersWithRuns = new Set(input.runs.map((run) => run.provider));
  for (const provider of expectedSet) {
    if (!providersWithRuns.has(provider)) {
      continue; // zero-run providers have empty evidence; they surface as incomplete
    }
    if (infraFailures.has(provider)) {
      continue; // infrastructure failure: evidence may be incomplete (ineligible)
    }
    const expectedUrls = uniqueResultUrls(input.runs, provider);
    const evidence = input.linkEvidence[provider];
    if (!Array.isArray(evidence)) {
      throw new BenchmarkInputError(`missing link evidence for ${provider}`);
    }
    const evidenceSet = new Set(evidence.map((entry) => entry.url));
    if (evidence.length !== expectedUrls.length || expectedUrls.some((url) => !evidenceSet.has(url))) {
      throw new BenchmarkInputError(`link evidence mismatch for ${provider}: expected ${expectedUrls.length} unique urls`);
    }
    if (evidence.some((entry) => typeof entry.url !== "string" || typeof entry.accessible !== "boolean")) {
      throw new BenchmarkInputError(`invalid link evidence entry for ${provider}`);
    }
  }
}
