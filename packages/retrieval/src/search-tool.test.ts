import { describe, expect, it, vi } from "vitest";
import type { SearchProvider, SearchRequest } from "./search-provider.js";
import { createSearchWebDefinition } from "./search-tool.js";

const context = { traceId: "trace-1", actor: "main_agent" as const };

function provider(timeRange: boolean) {
  const search = vi.fn(async (request: SearchRequest) => ({ provider: "test", results: [] }));
  return { search, value: { id: "test", capabilities: { timeRange }, search } as SearchProvider };
}

describe("web_search provider-aware date handling", () => {
  it("moves absolute dates into the actual query for providers without native timeRange", async () => {
    const fake = provider(false);
    const output = await createSearchWebDefinition(fake.value).execute(
      { query: "具身智能", maxResults: 8, timeRange: { from: "2026-06-14", to: "2026-09-14" } },
      context, new AbortController().signal, () => {},
    );
    expect(fake.search).toHaveBeenCalledWith({ query: "具身智能 2026-06-14 至 2026-09-14", maxResults: 8 }, expect.any(AbortSignal));
    expect(output.query).toBe("具身智能 2026-06-14 至 2026-09-14");
  });

  it("keeps native absolute timeRange for supporting providers", async () => {
    const fake = provider(true);
    await createSearchWebDefinition(fake.value).execute(
      { query: "具身智能", maxResults: 8, timeRange: { from: "2026-06-14", to: "2026-09-14" } },
      context, new AbortController().signal, () => {},
    );
    expect(fake.search).toHaveBeenCalledWith({ query: "具身智能", maxResults: 8, timeRange: { from: "2026-06-14", to: "2026-09-14" } }, expect.any(AbortSignal));
  });

  it("defaults omitted maxResults to five", async () => {
    const fake = provider(false);
    await createSearchWebDefinition(fake.value).execute(
      { query: "具身智能" } as never,
      context, new AbortController().signal, () => {},
    );
    expect(fake.search).toHaveBeenCalledWith({ query: "具身智能", maxResults: 5 }, expect.any(AbortSignal));
  });
});
