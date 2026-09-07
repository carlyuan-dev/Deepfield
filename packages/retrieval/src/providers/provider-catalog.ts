export const SUPPORTED_PROVIDER_IDS = Object.freeze([
  "brave",
  "tavily",
  "serper",
  "baidu",
  "metaso",
] as const);

export const BENCHMARK_CANDIDATES_V1 = Object.freeze([
  "baidu",
  "metaso",
  "tavily",
  "serper",
] as const);

export type SupportedProviderId = (typeof SUPPORTED_PROVIDER_IDS)[number];
export type LiveProviderId = (typeof BENCHMARK_CANDIDATES_V1)[number];

/** Approved environment variable names for the four v1 candidates. */
export const LIVE_PROVIDER_ENV_KEYS: Readonly<Record<LiveProviderId, string>> = Object.freeze({
  baidu: "BAIDU_SEARCH_API_KEY",
  metaso: "METASO_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  serper: "SERPER_API_KEY",
});

/** Keychain service names for the four v1 candidates. */
export const KEYCHAIN_SERVICES: Readonly<Record<LiveProviderId, string>> = Object.freeze({
  baidu: "com.deepfield.benchmark.baidu",
  metaso: "com.deepfield.benchmark.metaso",
  tavily: "com.deepfield.benchmark.tavily",
  serper: "com.deepfield.benchmark.serper",
});

/**
 * Temporary fail-closed boundary: assembles a COMPLETE map for the four v1
 * candidates from a partial supported-provider map. Brave may be
 * present in the input (it stays supported) but is never copied into the
 * result. Every candidate must be an own, defined entry; accessor entries are
 * never invoked. Returns a frozen null-prototype record. The error is the
 * stable `P2-T8A Phase 2 <label> assembly is incomplete: <missing ids>` and
 * never echoes entry values.
 */
export function requireBenchmarkCandidateAssembly<T>(
  label: string,
  entries: Readonly<Partial<Record<SupportedProviderId, T>>>,
): Readonly<Record<LiveProviderId, T>> {
  const missing: string[] = [];
  const assembled: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const provider of BENCHMARK_CANDIDATES_V1) {
    if (!Object.hasOwn(entries, provider)) {
      missing.push(provider);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(entries, provider);
    if (descriptor === undefined || "value" in descriptor === false) {
      missing.push(provider); // accessor entry: never invoked, treated as absent
      continue;
    }
    const value = descriptor.value;
    if (value === undefined) {
      missing.push(provider);
      continue;
    }
    assembled[provider] = value;
  }
  if (missing.length > 0) {
    throw new Error(`P2-T8A Phase 2 ${label} assembly is incomplete: ${missing.join(",")}`);
  }
  return Object.freeze(assembled) as Readonly<Record<LiveProviderId, T>>;
}
