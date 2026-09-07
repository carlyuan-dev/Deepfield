import { ProviderHttpClient, type ProviderEndpoint } from "../provider-http-client.js";
import type { SearchProvider } from "../search-provider.js";
import { ENDPOINT as BRAVE_ENDPOINT, createBraveProvider } from "./brave.js";
import { BAIDU_ENDPOINT, createBaiduProvider } from "./baidu.js";
import { METASO_ENDPOINT, createMetaSoProvider } from "./metaso.js";
import { ENDPOINT as TAVILY_ENDPOINT, createTavilyProvider } from "./tavily.js";
import { ENDPOINT as SERPER_ENDPOINT, createSerperProvider } from "./serper.js";
import { requireBenchmarkCandidateAssembly, type LiveProviderId, type SupportedProviderId } from "./provider-catalog.js";
import { resolveLiveRun } from "./live-config.js";
import { parseProviderPricingJson, type ProviderPrice } from "../benchmark/pricing.js";

export type LiveProviderFactory = (client: ProviderHttpClient, token: string) => SearchProvider;

const ENDPOINT_ENTRIES: Partial<Record<SupportedProviderId, ProviderEndpoint>> = {
  brave: BRAVE_ENDPOINT,
  baidu: BAIDU_ENDPOINT,
  metaso: METASO_ENDPOINT,
  tavily: TAVILY_ENDPOINT,
  serper: SERPER_ENDPOINT,
};

const FACTORY_ENTRIES: Partial<Record<SupportedProviderId, LiveProviderFactory>> = {
  brave: (client, token) => createBraveProvider({ client, token }),
  baidu: (client, token) => createBaiduProvider({ client, token, authHeader: "authorization" }),
  metaso: (client, token) => createMetaSoProvider({ client, token }),
  tavily: (client, token) => createTavilyProvider({ client, token }),
  serper: (client, token) => createSerperProvider({ client, token }),
};

/**
 * Immutable four-candidate live maps: exact canonical keys, null prototype,
 * frozen, no Brave, no undefined/placeholder entries. Brave stays supported but
 * is never part of the live candidate set.
 */
export const LIVE_PROVIDER_ENDPOINTS: Readonly<Record<LiveProviderId, ProviderEndpoint>> = requireBenchmarkCandidateAssembly(
  "live endpoints",
  ENDPOINT_ENTRIES,
);

export const LIVE_PROVIDER_FACTORIES: Readonly<Record<LiveProviderId, LiveProviderFactory>> = requireBenchmarkCandidateAssembly(
  "live factories",
  FACTORY_ENTRIES,
);

export interface LiveProviderSetup {
  readonly providers: readonly LiveProviderId[];
  readonly tokens: Readonly<Record<LiveProviderId, string>>;
  readonly pricing: Readonly<Record<LiveProviderId, ProviderPrice>>;
}

/** Reads an env value ONLY through its own data property descriptor. */
function ownDataEnvironmentValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  if (descriptor === undefined || "value" in descriptor === false) {
    return undefined; // accessors are never invoked; inherited values are never accepted
  }
  return descriptor.value;
}

/**
 * Single pre-I/O live boundary: validates the exact four-provider selection,
 * the four keys and the exact four native-currency price records, returning a
 * frozen setup. Failures use fixed sanitized messages; no factory, transport
 * or getter ever runs.
 */
export function resolveLiveProviderSetup(env: Record<string, string | undefined>): LiveProviderSetup {
  const run = resolveLiveRun(env);
  const pricing = parseProviderPricingJson(ownDataEnvironmentValue(env, "DEEPFIELD_SEARCH_PRICING"), run.providers);
  return Object.freeze({
    providers: Object.freeze([...run.providers]),
    tokens: run.tokens,
    pricing,
  });
}
