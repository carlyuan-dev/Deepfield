import { describe, expect, it } from "vitest";
import type { NormalizedSearchResponse, NormalizedSearchResult } from "../search-provider.js";
import { acceptLiveProviderResponse } from "./provider-live-acceptance.js";

function result(overrides: Partial<NormalizedSearchResult> & { url: string }): NormalizedSearchResult {
  return {
    title: "Synthetic Title",
    snippet: "Synthetic snippet.",
    rank: 1,
    provider: "baidu",
    ...overrides,
  };
}

function response(provider: string, results: unknown[] | unknown): NormalizedSearchResponse {
  return { provider, results: results as NormalizedSearchResult[] };
}

describe("live provider URL-bearing acceptance guard (focused revision)", () => {
  it("accepts the expected provider with at least one http/https result without mutating the response", () => {
    const frozen = response("baidu", [result({ url: "https://example.com/a" }), result({ url: "http://other.example/b", rank: 2 })]);
    Object.freeze(frozen);
    Object.freeze(frozen.results);
    Object.freeze(frozen.results[0]);
    Object.freeze(frozen.results[1]);
    expect(() => acceptLiveProviderResponse("baidu", frozen)).not.toThrow();
    expect(frozen.results).toHaveLength(2);
    expect(frozen.results[0]!.url).toBe("https://example.com/a");
  });

  it("REJECTS an empty results array even when the provider id matches", () => {
    // current live acceptance (provider match + array) would wrongly allow this
    expect(() => acceptLiveProviderResponse("baidu", response("baidu", []))).toThrow(
      /live provider response contained no clickable results/,
    );
  });

  it("rejects a provider mismatch and a non-array results payload", () => {
    expect(() => acceptLiveProviderResponse("baidu", response("tavily", [result({ url: "https://example.com/" })]))).toThrow(
      /live provider response provider mismatch/,
    );
    const notArray = { provider: "baidu", results: "nope" } as unknown as NormalizedSearchResponse;
    expect(() => acceptLiveProviderResponse("baidu", notArray)).toThrow(/live provider response results are not an array/);
  });

  it("rejects missing, non-string, unparseable and non-http(s) result urls", () => {
    const cases: Array<{ url: unknown }> = [
      { url: undefined },
      { url: 42 },
      { url: "" },
      { url: "https://" },
      { url: "not a url" },
      { url: "ftp://example.com/file" },
      { url: "javascript:alert(1)" },
      { url: "http://" },
    ];
    for (const bad of cases) {
      const entry = { url: bad.url };
      expect(() => acceptLiveProviderResponse("baidu", response("baidu", [entry as NormalizedSearchResult]))).toThrow(
        /live provider response contained an unusable result url/,
      );
    }
  });

  it("rejects the whole response when ANY result url is unusable", () => {
    const mixed = response("baidu", [
      result({ url: "https://good.example/1" }),
      result({ url: "https://good.example/2", rank: 2 }),
      result({ url: "javascript:bad()", rank: 3 }),
    ]);
    expect(() => acceptLiveProviderResponse("baidu", mixed)).toThrow(/live provider response contained an unusable result url/);
  });

  it("keeps every rejection message fixed and free of distinctive input values", () => {
    const FIXED_GUARD_MESSAGES = [
      "live provider response provider mismatch",
      "live provider response results are not an array",
      "live provider response contained no clickable results",
      "live provider response contained an unusable result url",
    ];
    const FORBIDDEN = ["sk-secret-host", "sk-live-secret", "sk-live-provider", "sk-live-results", "javascript:", "not a url"];
    const secretUrl = "https://sk-secret-host.example/path?token=sk-live-secret";
    const cases: Array<() => void> = [
      () => acceptLiveProviderResponse("baidu", response("other", [result({ url: secretUrl })])),
      () => acceptLiveProviderResponse("baidu", response("baidu", [])),
      () => acceptLiveProviderResponse("baidu", { provider: "baidu", results: "sk-live-results" } as unknown as NormalizedSearchResponse),
      () => acceptLiveProviderResponse("baidu", response("baidu", [result({ url: secretUrl }), result({ url: "not a url", rank: 2 })])),
      () => acceptLiveProviderResponse("baidu", { provider: "sk-live-provider", results: [result({ url: "https://example.com/" })] } as unknown as NormalizedSearchResponse),
    ];
    for (const attempt of cases) {
      // capture ONLY what the guard threw; if it did NOT throw, `caught` stays
      // undefined and the assertions below FAIL the test loudly — we never
      // catch a sentinel that the test itself generated.
      let caught: unknown;
      try {
        attempt();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = String((caught as Error).message);
      expect(FIXED_GUARD_MESSAGES).toContain(message);
      for (const forbidden of FORBIDDEN) {
        expect(message).not.toContain(forbidden);
      }
    }
  });
});
