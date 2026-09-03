import {
  BENCHMARK_CANDIDATES_V1,
  LIVE_PROVIDER_ENV_KEYS,
  type LiveProviderId,
} from "./provider-catalog.js";

export type { LiveProviderId } from "./provider-catalog.js";

/**
 * Strict fail-closed selection of the live provider set from
 * DEEPFIELD_SEARCH_PROVIDERS (comma separated). The parsed set must EXACTLY
 * equal the frozen v1 candidate set — empty entries, unknown ids, duplicates,
 * missing candidates and Brave are all rejected — and the canonical candidate
 * order is always returned (never inferred from available keys).
 */
export function resolveLiveProviders(raw: string | undefined): readonly LiveProviderId[] {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error("DEEPFIELD_SEARCH_PROVIDERS is required (all five v1 candidates, comma separated)");
  }
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new Error("invalid DEEPFIELD_SEARCH_PROVIDERS: empty entry");
  }
  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part)) {
      throw new Error(`invalid DEEPFIELD_SEARCH_PROVIDERS: duplicate provider "${part}"`);
    }
    seen.add(part);
  }
  for (const part of parts) {
    if (!BENCHMARK_CANDIDATES_V1.includes(part as LiveProviderId)) {
      throw new Error(`invalid DEEPFIELD_SEARCH_PROVIDERS: unknown provider "${part}"`);
    }
  }
  const candidateSet = new Set<string>(BENCHMARK_CANDIDATES_V1);
  if (seen.size !== candidateSet.size || [...seen].some((part) => !candidateSet.has(part))) {
    throw new Error("invalid DEEPFIELD_SEARCH_PROVIDERS: must select exactly the five v1 candidates");
  }
  return [...BENCHMARK_CANDIDATES_V1];
}

/**
 * Requires a key for EVERY selected provider (the five v1 candidates). Called
 * before any network request or report write; a missing or blank key fails the
 * whole live run loudly. Errors contain only env variable and provider names —
 * never any key value.
 */
export function requireLiveKeys(
  providers: readonly LiveProviderId[],
  env: Record<string, string | undefined>,
): Record<LiveProviderId, string> {
  const tokens = Object.create(null) as Record<LiveProviderId, string>;
  for (const provider of providers) {
    const name = LIVE_PROVIDER_ENV_KEYS[provider];
    const value = env[name];
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`${name} is required for the selected provider "${provider}"`);
    }
    tokens[provider] = value;
  }
  return tokens;
}

/** One-shot live run setup: strict selection + keys, failing before any I/O. */
export function resolveLiveRun(env: Record<string, string | undefined>): { providers: readonly LiveProviderId[]; tokens: Record<LiveProviderId, string> } {
  const providers = resolveLiveProviders(env.DEEPFIELD_SEARCH_PROVIDERS);
  const tokens = requireLiveKeys(providers, env);
  return { providers, tokens };
}
