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
 * linkEvidence keys must EXACTLY match expectedProviders; linkCheckFailures
 * must be a unique subset of expectedProviders; and per-provider evidence must
 * only contain URLs from that provider's expected result set (no unknown,
 * duplicate or forged urls). WITHOUT an infra failure the evidence set must
 * equal the expected set exactly; WITH one it may be a real subset. A zero-run
 * provider has an empty expected set, so its evidence must be empty. Any
 * illegal measurement rejects the WHOLE benchmark before scoring — never
 * clamped, interpolated or rewarded.
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

  // linkCheckFailures: unique subset of expectedProviders, string entries only
  const infraFailures = new Set<string>();
  if (input.linkCheckFailures !== undefined) {
    if (!Array.isArray(input.linkCheckFailures)) {
      throw new BenchmarkInputError("invalid linkCheckFailures: must be an array");
    }
    for (const provider of input.linkCheckFailures) {
      if (typeof provider !== "string" || !expectedSet.has(provider)) {
        throw new BenchmarkInputError(`invalid linkCheckFailures entry: not an expected provider`);
      }
      if (infraFailures.has(provider)) {
        throw new BenchmarkInputError(`duplicate linkCheckFailures entry "${provider}"`);
      }
      infraFailures.add(provider);
    }
  }

  // linkEvidence keys must EXACTLY match expectedProviders
  if (typeof input.linkEvidence !== "object" || input.linkEvidence === null || Array.isArray(input.linkEvidence)) {
    throw new BenchmarkInputError("invalid linkEvidence");
  }
  const evidenceKeys = Object.keys(input.linkEvidence);
  if (evidenceKeys.length !== expectedSet.size || evidenceKeys.some((key) => !expectedSet.has(key))) {
    throw new BenchmarkInputError("linkEvidence keys must exactly match expectedProviders");
  }

  for (const provider of expectedSet) {
    const expectedUrls = uniqueResultUrls(input.runs, provider);
    const expectedUrlSet = new Set(expectedUrls);
    const evidence = input.linkEvidence[provider];
    if (!Array.isArray(evidence)) {
      throw new BenchmarkInputError(`missing link evidence for ${provider}`);
    }
    const seen = new Set<string>();
    for (const entry of evidence) {
      if (typeof entry !== "object" || entry === null || typeof entry.url !== "string" || typeof entry.accessible !== "boolean") {
        throw new BenchmarkInputError(`invalid link evidence entry for ${provider}`);
      }
      if (seen.has(entry.url)) {
        throw new BenchmarkInputError(`duplicate link evidence url for ${provider}`);
      }
      seen.add(entry.url);
      if (!expectedUrlSet.has(entry.url)) {
        throw new BenchmarkInputError(`link evidence url outside expected set for ${provider}`);
      }
    }
    if (!infraFailures.has(provider)) {
      if (seen.size !== expectedUrls.length) {
        throw new BenchmarkInputError(`link evidence mismatch for ${provider}: expected ${expectedUrls.length} unique urls`);
      }
    }
    // infra failure: a strict subset (real completed checks) is allowed; unknown/duplicate/forged already rejected above
  }
}
