import type { NormalizedSearchResponse } from "../search-provider.js";

/**
 * Offline-verifiable acceptance boundary for OPT-IN live provider probes.
 * A live green result must prove the provider answered with at least one
 * clickable http(s) result for the expected provider id — an empty array is
 * NOT compatible. Pure function: never touches the network and never mutates
 * the response. Errors are fixed and value-free: no raw URL, query, token or
 * provider payload ever appears in a message.
 */
export function acceptLiveProviderResponse(expectedProviderId: string, response: NormalizedSearchResponse): void {
  if (response.provider !== expectedProviderId) {
    throw new Error("live provider response provider mismatch");
  }
  if (!Array.isArray(response.results)) {
    throw new Error("live provider response results are not an array");
  }
  if (response.results.length === 0) {
    throw new Error("live provider response contained no clickable results");
  }
  for (const entry of response.results) {
    if (typeof entry.url !== "string") {
      throw new Error("live provider response contained an unusable result url");
    }
    let parsed: URL;
    try {
      parsed = new URL(entry.url);
    } catch {
      throw new Error("live provider response contained an unusable result url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("live provider response contained an unusable result url");
    }
  }
}
