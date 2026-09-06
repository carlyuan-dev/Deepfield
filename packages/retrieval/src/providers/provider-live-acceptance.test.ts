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
    const secretUrl = "https://sk-secret-host.example/path?token=sk-live-secret";
    const cases: Array<() => void> = [
      () => acceptLiveProviderResponse("baidu", response("other", [result({ url: secretUrl })])),
      () => acceptLiveProviderResponse("baidu", response("baidu", [])),
      () => acceptLiveProviderResponse("baidu", { provider: "baidu", results: "sk-live-results" } as unknown as NormalizedSearchResponse),
      () => acceptLiveProviderResponse("baidu", response("baidu", [result({ url: secretUrl }), result({ url: "not a url", rank: 2 })])),
      () => acceptLiveProviderResponse("baidu", { provider: "sk-live-provider", results: [result({ url: "https://example.com/" })] } as unknown as NormalizedSearchResponse),
    ];
    for (const attempt of cases) {
      try {
        attempt();
        throw new Error("unreachable");
      } catch (error) {
        const message = String(error);
        expect(message).not.toContain("sk-secret-host");
        expect(message).not.toContain("sk-live-secret");
        expect(message).not.toContain("sk-live-provider");
        expect(message).not.toContain("sk-live-results");
        expect(message).not.toContain("javascript:");
        expect(message).not.toContain("not a url");
      }
    }
  });
});
