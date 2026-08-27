/**
 * Single source of truth for live provider environment keys. Both live entry
 * points (provider contract smoke + search benchmark) MUST use these exact
 * names so a missing key fails identically everywhere.
 */
export const LIVE_PROVIDER_KEYS = {
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  serper: "SERPER_API_KEY",
} as const;

export type LiveProviderId = keyof typeof LIVE_PROVIDER_KEYS;

export function requireProviderKey(provider: LiveProviderId): string {
  const name = LIVE_PROVIDER_KEYS[provider];
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required to run live provider tests`);
  }
  return value;
}
