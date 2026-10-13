import { describe, expect, it } from "vitest";
import type { SearchRuntimeSnapshot } from "@deepfield/contracts";
import { createSearchProvider, listSearchProviderManifests } from "./provider-registry.js";
import { listSearchProviderManifests as baseManifests, SearchProfileDraftSchema } from "@deepfield/base/config";
import { Value } from "typebox/value";

describe("production search provider registry", () => {
  it("shares pure metadata with Base and keeps strict options validation at execution", () => {
    expect(listSearchProviderManifests).toBe(baseManifests);
    const draft = { name: "draft", provider: "tavily", baseUrl: "https://api.tavily.com", options: { unsupported: true } } as const;
    expect(Value.Check(SearchProfileDraftSchema, draft)).toBe(true);
    expect(() => createSearchProvider({ ...draft, id: "one", apiKey: "test-token" })).toThrow();
  });
  it("exposes the product providers and constructs each default adapter", () => {
    const manifests = listSearchProviderManifests();
    expect(manifests.map(({ id }) => id)).toEqual(["metaso", "baidu", "zhipu", "tavily", "serper", "doubao"]);
    expect(manifests.map(({ id }) => id)).not.toContain("brave");
    for (const manifest of manifests) {
      const options = manifest.id === "zhipu"
        ? { searchEngine: "search_std" }
        : manifest.id === "baidu"
          ? { authHeader: "authorization" }
          : {};
      const snapshot: SearchRuntimeSnapshot = {
        id: `profile-${manifest.id}`,
        name: manifest.displayName,
        provider: manifest.id,
        baseUrl: manifest.defaultBaseUrl,
        options,
        apiKey: "test-token",
      };
      expect(createSearchProvider(snapshot).id).toBe(manifest.id);
    }
  });
  it("constructs Doubao Custom with the search credential and no advanced options", () => {
    const manifest = listSearchProviderManifests().find(({ id }) => id === "doubao");
    expect(manifest).toMatchObject({ displayName: "豆包搜索 Custom", defaultBaseUrl: "https://open.feedcoopapi.com", optionFields: [], capabilities: { timeFilter: "exact_range" } });
    expect(createSearchProvider({ id: "doubao", name: "搜索", provider: "doubao", baseUrl: "https://proxy.example/search", apiKey: "search-key", options: {} }).capabilities).toEqual({ timeRange: true, maxQueryLength: 100 });
    expect(() => createSearchProvider({ id: "doubao", name: "搜索", provider: "doubao", baseUrl: "http://proxy.example", apiKey: "search-key", options: {} })).toThrow();
  });
});
