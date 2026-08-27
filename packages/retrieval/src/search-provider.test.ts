import { describe, expect, it } from "vitest";
import {
  MAX_RESULT_SNIPPET_LENGTH,
  MAX_RESULT_TITLE_LENGTH,
  MAX_RESULT_URL_LENGTH,
  MAX_RESULTS,
  SearchProviderError,
  assertValidSearchRequest,
  normalizeSearchResults,
  type NormalizedSearchResponse,
  type RawSearchResult,
} from "./search-provider.js";

const RAW_OK: readonly RawSearchResult[] = [
  { title: "Official", url: "https://example.com", snippet: "snippet one" },
  { title: "Second", url: "https://other.example/path", snippet: "snippet two" },
];

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected SearchProviderError with code ${code}`);
}

describe("search provider normalized contract (focused revision)", () => {
  it("normalizes a fixture into only title/url/snippet/rank/provider", () => {
    const response: NormalizedSearchResponse = normalizeSearchResults("fake", RAW_OK, 20);
    expect(response).toEqual({
      provider: "fake",
      results: [
        { title: "Official", url: "https://example.com/", snippet: "snippet one", rank: 1, provider: "fake" },
        { title: "Second", url: "https://other.example/path", snippet: "snippet two", rank: 2, provider: "fake" },
      ],
    });
    // extra raw fields never leak into the normalized output
    const withExtra: readonly RawSearchResult[] = [
      { title: "A", url: "https://a.example", snippet: "s", internal: { secret: "never-leak" }, token: "sk-x" },
    ];
    const normalized = normalizeSearchResults("fake", withExtra, 20);
    expect(normalized.results[0]).toEqual({ title: "A", url: "https://a.example/", snippet: "s", rank: 1, provider: "fake" });
    expect(JSON.stringify(normalized)).not.toContain("sk-x");
  });

  it("supports an optional ISO date and rejects malformed dates", () => {
    const withDate = normalizeSearchResults("fake", [
      { title: "D", url: "https://d.example", snippet: "s", date: "2026-08-27" },
    ], 20);
    expect(withDate.results[0]!.date).toBe("2026-08-27");
    expectCode(() => normalizeSearchResults("fake", [{ title: "D", url: "https://d.example", snippet: "s", date: "not-a-date" }], 20), "malformed_response");
    expectCode(() => normalizeSearchResults("fake", [{ title: "D", url: "https://d.example", snippet: "s", date: "2026-13-99" }], 20), "malformed_response");
    // real calendar validation: 2026-02-30 and 2023-02-29 must be rejected
    expectCode(() => normalizeSearchResults("fake", [{ title: "D", url: "https://d.example", snippet: "s", date: "2026-02-30" }], 20), "malformed_response");
    expectCode(() => normalizeSearchResults("fake", [{ title: "D", url: "https://d.example", snippet: "s", date: "2023-02-29" }], 20), "malformed_response");
    // leap years and month ends are accepted
    expect(normalizeSearchResults("fake", [{ title: "D", url: "https://d.example", snippet: "s", date: "2024-02-29" }], 20).results[0]!.date).toBe("2024-02-29");
    expect(normalizeSearchResults("fake", [{ title: "D", url: "https://d.example", snippet: "s", date: "2026-04-30" }], 20).results[0]!.date).toBe("2026-04-30");
    expectCode(() => normalizeSearchResults("fake", [{ title: "D", url: "https://d.example", snippet: "s", date: "2026-04-31" }], 20), "malformed_response");
  });

  it("normalizes URLs and rejects percent-encoded expansion beyond the bound", () => {
    // raw string fits but the normalized href exceeds the bound
    const emojiPath = "\u{1F600}".repeat(300); // raw ≈ 618, normalized ≈ 3600
    expect(emojiPath.length).toBeLessThan(MAX_RESULT_URL_LENGTH);
    expectCode(() => normalizeSearchResults("fake", [{ title: "A", url: `https://x.example/${emojiPath}`, snippet: "s" }], 20), "dangerous_url");
    // the normalized output is the VERIFIED parsed href (never the raw value)
    const ok = normalizeSearchResults("fake", [{ title: "A", url: "https://EXAMPLE.com/a%20b", snippet: "s" }], 20);
    expect(ok.results[0]!.url).toBe("https://example.com/a%20b");
  });

  it("validates provider ids: non-empty and bounded", () => {
    expectCode(() => normalizeSearchResults("", RAW_OK, 20), "invalid_request");
    expectCode(() => normalizeSearchResults("p".repeat(65), RAW_OK, 20), "invalid_request");
    expect(normalizeSearchResults("brave", RAW_OK, 20).provider).toBe("brave");
  });

  it("rejects duplicate and invalid ranks", () => {
    expectCode(() => normalizeSearchResults("fake", [
        { title: "A", url: "https://a.example", snippet: "s", rank: 1 },
        { title: "B", url: "https://b.example", snippet: "s", rank: 1 },
      ], 20), "malformed_response");
    expectCode(() => normalizeSearchResults("fake", [{ title: "A", url: "https://a.example", snippet: "s", rank: 0 }], 20), "malformed_response");
    expectCode(() => normalizeSearchResults("fake", [{ title: "A", url: "https://a.example", snippet: "s", rank: 1.5 }], 20), "malformed_response");
  });

  it("rejects mixed implicit/explicit rank duplicates in both orders", () => {
    // implicit (index+1 = 1) then explicit 1
    expectCode(() => normalizeSearchResults("fake", [
        { title: "A", url: "https://a.example", snippet: "s" },
        { title: "B", url: "https://b.example", snippet: "s", rank: 1 },
      ], 20), "malformed_response");
    // explicit 2 then implicit (index+1 = 2)
    expectCode(() => normalizeSearchResults("fake", [
        { title: "A", url: "https://a.example", snippet: "s", rank: 2 },
        { title: "B", url: "https://b.example", snippet: "s" },
      ], 20), "malformed_response");
  });

  it("rejects dangerous and malformed URLs", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "not a url", `https://x.example/${"p".repeat(MAX_RESULT_URL_LENGTH + 1)}`]) {
      expectCode(() => normalizeSearchResults("fake", [{ title: "A", url, snippet: "s" }], 20), "dangerous_url");
    }
    expect(() => normalizeSearchResults("fake", [{ title: "A", url: undefined, snippet: "s" }], 20)).toThrow(SearchProviderError);
  });

  it("normalizes URLs and rejects percent-encoded expansion beyond the bound", () => {
    const emojiPath = "\u{1F600}".repeat(300); // raw ≈ 618, normalized ≈ 3600
    expect(emojiPath.length).toBeLessThan(MAX_RESULT_URL_LENGTH);
    expectCode(() => normalizeSearchResults("fake", [{ title: "A", url: `https://x.example/${emojiPath}`, snippet: "s" }], 20), "dangerous_url");
    // the normalized output is the VERIFIED parsed href (never the raw value)
    const ok = normalizeSearchResults("fake", [{ title: "A", url: "https://EXAMPLE.com/a%20b", snippet: "s" }], 20);
    expect(ok.results[0]!.url).toBe("https://example.com/a%20b");
  });

  it("rejects whitespace-only queries at the shared request boundary", () => {
    expectCode(() => assertValidSearchRequest({ query: "   ", maxResults: 5 }), "invalid_request");
    expectCode(() => assertValidSearchRequest({ query: "\t\n ", maxResults: 5 }), "invalid_request");
    expect(() => assertValidSearchRequest({ query: " 人形机器人 ", maxResults: 5 })).not.toThrow();
  });

  it("rejects malformed strings and caps every string field", () => {
    expect(() =>
      normalizeSearchResults("fake", [{ title: 42, url: "https://a.example", snippet: "s" }], 20),
    ).toThrow(SearchProviderError);
    expect(() =>
      normalizeSearchResults("fake", [{ title: "t", url: "https://a.example", snippet: 42 }], 20),
    ).toThrow(SearchProviderError);
    expectCode(() => normalizeSearchResults("fake", [{ title: "t".repeat(MAX_RESULT_TITLE_LENGTH + 1), url: "https://a.example", snippet: "s" }], 20), "malformed_response");
    expectCode(() => normalizeSearchResults("fake", [{ title: "t", url: "https://a.example", snippet: "s".repeat(MAX_RESULT_SNIPPET_LENGTH + 1) }], 20), "malformed_response");
  });

  it("rejects non-array results, missing fields and out-of-range maxResults", () => {
    expect(() => normalizeSearchResults("fake", undefined as never, 20)).toThrow(SearchProviderError);
    expect(() => normalizeSearchResults("fake", "nope" as never, 20)).toThrow(SearchProviderError);
    expect(() => normalizeSearchResults("fake", [{ url: "https://a.example", snippet: "s" }], 20)).toThrow(SearchProviderError);
    expect(() => normalizeSearchResults("fake", RAW_OK, 0)).toThrow(SearchProviderError);
    expect(() => normalizeSearchResults("fake", RAW_OK, MAX_RESULTS + 1)).toThrow(SearchProviderError);
    expect(() => normalizeSearchResults("fake", RAW_OK, 1.5)).toThrow(SearchProviderError);
  });

  it("caps the result count at maxResults and never returns more than MAX_RESULTS", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://x.example/${i}`, snippet: "s" }));
    expect(normalizeSearchResults("fake", many, 5).results).toHaveLength(5);
    expect(normalizeSearchResults("fake", many, 20).results).toHaveLength(20);
  });

  it("keeps stable provider error messages free of raw payloads", () => {
    try {
      normalizeSearchResults("fake", [{ title: "A", url: "javascript:bad", snippet: "secret-in-snippet" }], 20);
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(SearchProviderError);
      expect(String(error)).not.toContain("javascript:bad");
      expect(String(error)).not.toContain("secret-in-snippet");
    }
  });

  it("validates timeRange with real calendar dates and from<=to", () => {
    expectCode(() => assertValidSearchRequest({ query: "x", maxResults: 5, timeRange: { from: "2026-02-30", to: "2026-03-01" } }), "invalid_request");
    expectCode(() => assertValidSearchRequest({ query: "x", maxResults: 5, timeRange: { from: "2026-03-01", to: "2026-02-01" } }), "invalid_request");
    expectCode(() => assertValidSearchRequest({ query: "x", maxResults: 5, timeRange: { from: "2026-13-01", to: "2026-03-01" } }), "invalid_request");
    expectCode(() => assertValidSearchRequest({ query: "x", maxResults: 5, timeRange: { from: "not-a-date", to: "2026-03-01" } }), "invalid_request");
    // from == to is a legal single-day range
    expect(() => assertValidSearchRequest({ query: "x", maxResults: 5, timeRange: { from: "2026-03-01", to: "2026-03-01" } })).not.toThrow();
    // leap boundaries
    expect(() => assertValidSearchRequest({ query: "x", maxResults: 5, timeRange: { from: "2024-02-29", to: "2026-04-30" } })).not.toThrow();
    expectCode(() => assertValidSearchRequest({ query: "x", maxResults: 5, timeRange: { from: "2023-02-29", to: "2026-04-30" } }), "invalid_request");
  });
});
