import { BENCHMARK_CANDIDATES_V1, type LiveProviderId } from "./provider-catalog.js";

/**
 * Internal (never package-exported) fixed scope for the OPT-IN provider
 * contract live suite. The launcher owns the env value: `provider-contract`
 * clears DEEPFIELD_SEARCH_CONTRACT_SCOPE so all four candidates run;
 * `provider-contract-overseas` exports exactly "overseas" so ONLY tavily and
 * serper run. Arbitrary provider CSV or caller-chosen targets are rejected.
 */
export const CONTRACT_SCOPE_ENV = "DEEPFIELD_SEARCH_CONTRACT_SCOPE";

/** Fixed overseas target order: tavily, serper (both canonical members). */
export const OVERSEAS_CONTRACT_PROVIDERS: Readonly<LiveProviderId[]> = Object.freeze([
  "tavily",
  "serper",
] as const);

function invalidScope(): never {
  throw new Error("invalid provider contract scope"); // fixed: never echoes input
}

/**
 * Pure scope resolution over an env-like object. Missing own value -> frozen
 * full canonical set; exact own "overseas" -> frozen ["tavily","serper"].
 * Blank, unknown, inherited and accessor (never executed) values are rejected
 * with a fixed sanitized error. The input is never modified.
 */
export function resolveContractScope(env: Record<string, string | undefined>): Readonly<LiveProviderId[]> {
  const descriptor = Object.getOwnPropertyDescriptor(env, CONTRACT_SCOPE_ENV);
  if (descriptor !== undefined && "value" in descriptor === false) {
    invalidScope(); // accessor: the getter never runs
  }
  if (descriptor === undefined) {
    // an inherited definition (walking prototypes via own descriptors only,
    // so no getter is ever executed) counts as present-but-invalid
    let current: object = env;
    for (;;) {
      const proto = Object.getPrototypeOf(current);
      if (proto === null) {
        return BENCHMARK_CANDIDATES_V1; // genuinely missing: full canonical set
      }
      if (Object.getOwnPropertyDescriptor(proto, CONTRACT_SCOPE_ENV) !== undefined) {
        invalidScope(); // inherited scope value
      }
      current = proto;
    }
  }
  const value = descriptor.value;
  if (value === undefined) {
    return BENCHMARK_CANDIDATES_V1;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidScope(); // blank
  }
  if (value !== "overseas") {
    invalidScope(); // unknown / non-exact value
  }
  const canonical = new Set<string>(BENCHMARK_CANDIDATES_V1);
  if (!OVERSEAS_CONTRACT_PROVIDERS.every((id) => canonical.has(id))) {
    invalidScope(); // overseas targets must stay canonical members
  }
  return OVERSEAS_CONTRACT_PROVIDERS;
}
