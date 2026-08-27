export const ALL_LIVE_PROVIDERS = ["brave", "tavily", "serper"] as const;
export type LiveProviderId = (typeof ALL_LIVE_PROVIDERS)[number];

const LIVE_PROVIDER_KEYS: Record<LiveProviderId, string> = {
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  serper: "SERPER_API_KEY",
};

/**
 * Strict fail-closed selection of the live provider set from
 * DEEPFIELD_SEARCH_PROVIDERS (comma separated). Unknown, duplicate or fewer
 * than two providers are rejected so a live run can never silently narrow
 * itself down to a bogus subset. Both live entry points share this function.
 */
export function resolveLiveProviders(raw: string | undefined): readonly LiveProviderId[] {
  if (raw === undefined || raw.trim().length === 0) {
    throw new Error("DEEPFIELD_SEARCH_PROVIDERS is required (e.g. brave,tavily)");
  }
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new Error("invalid DEEPFIELD_SEARCH_PROVIDERS: empty entry");
  }
  const seen = new Set<LiveProviderId>();
  for (const part of parts) {
    if (!(ALL_LIVE_PROVIDERS as readonly string[]).includes(part)) {
      throw new Error(`invalid DEEPFIELD_SEARCH_PROVIDERS: unknown provider "${part}"`);
    }
    if (seen.has(part as LiveProviderId)) {
      throw new Error(`invalid DEEPFIELD_SEARCH_PROVIDERS: duplicate provider "${part}"`);
    }
    seen.add(part as LiveProviderId);
  }
  if (seen.size < 2) {
    throw new Error("DEEPFIELD_SEARCH_PROVIDERS must select at least two providers");
  }
  return [...seen];
}

/**
 * Requires a key for EVERY selected provider. Called before any network
 * request or report write; a missing key fails the whole live run loudly.
 */
export function requireLiveKeys(
  providers: readonly LiveProviderId[],
  env: Record<string, string | undefined>,
): Record<LiveProviderId, string> {
  const tokens: Record<LiveProviderId, string> = {} as Record<LiveProviderId, string>;
  for (const provider of providers) {
    const name = LIVE_PROVIDER_KEYS[provider];
    const value = env[name];
    if (value === undefined || value.length === 0) {
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

