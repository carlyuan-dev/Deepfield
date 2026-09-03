import {
  BENCHMARK_CANDIDATES_V1,
  LIVE_PROVIDER_ENV_KEYS,
  type LiveProviderId,
} from "./provider-catalog.js";

export type { LiveProviderId } from "./provider-catalog.js";

/** One live probe binding: a candidate, its assembled factory and its env-sourced token. */
export interface LiveProbeBinding<T> {
  id: LiveProviderId;
  binding: T;
  token: string;
}

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

/** Reads an env value ONLY through its own data property descriptor. */
function ownEnvValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  if (descriptor === undefined || "value" in descriptor === false) {
    return undefined; // accessors are never invoked; inherited values are never accepted
  }
  return descriptor.value;
}

/**
 * Requires a key for EVERY v1 candidate. The providers set must EXACTLY equal
 * BENCHMARK_CANDIDATES_V1 (subset, duplicate, missing-candidate and runtime
 * unknown ids are all rejected with a fixed sanitized error BEFORE any env
 * value is read — no input ids or values are echoed). Each env value must be a
 * non-blank own string. The returned token record is frozen with a null
 * prototype so it cannot be replaced after validation.
 */
export function requireLiveKeys(
  providers: readonly LiveProviderId[],
  env: Record<string, string | undefined>,
): Readonly<Record<LiveProviderId, string>> {
  if (!Array.isArray(providers) || providers.length !== BENCHMARK_CANDIDATES_V1.length) {
    throw new Error("live keys require exactly the five v1 candidates");
  }
  const set = new Set(providers);
  if (set.size !== BENCHMARK_CANDIDATES_V1.length || BENCHMARK_CANDIDATES_V1.some((provider) => !set.has(provider))) {
    throw new Error("live keys require exactly the five v1 candidates");
  }
  const tokens = Object.create(null) as Record<LiveProviderId, string>;
  for (const provider of BENCHMARK_CANDIDATES_V1) {
    const name = LIVE_PROVIDER_ENV_KEYS[provider];
    const value = ownEnvValue(env, name);
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${name} is required for the selected provider "${provider}"`);
    }
    tokens[provider] = value;
  }
  return Object.freeze(tokens);
}

/** One-shot live run setup: strict selection + keys, failing before any I/O. */
export function resolveLiveRun(env: Record<string, string | undefined>): { providers: readonly LiveProviderId[]; tokens: Readonly<Record<LiveProviderId, string>> } {
  const providers = resolveLiveProviders(env.DEEPFIELD_SEARCH_PROVIDERS);
  const tokens = requireLiveKeys(providers, env);
  return { providers, tokens };
}

/**
 * Binds an assembled factory/endpoint record to env-sourced tokens. Call this
 * AFTER requireBenchmarkCandidateAssembly has passed so the complete candidate
 * record is the only map indexed; every probe token comes from the resolved
 * environment — never from a placeholder literal.
 */
export function bindLiveProbe<T>(
  assembly: Readonly<Record<LiveProviderId, T>>,
  env: Record<string, string | undefined>,
): readonly LiveProbeBinding<T>[] {
  const run = resolveLiveRun(env);
  return run.providers.map((id) => ({ id, binding: assembly[id], token: run.tokens[id] }));
}
