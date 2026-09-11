import { describe, expect, it } from "vitest";
import type { SearchRuntimeSnapshot } from "@deepfield/contracts";
import { createSearchProvider, listSearchProviderManifests } from "./provider-registry.js";

describe("production search provider registry", () => {
  it("exposes exactly the five product providers and constructs each default adapter", () => {
    const manifests = listSearchProviderManifests();
    expect(manifests.map(({ id }) => id)).toEqual(["metaso", "baidu", "zhipu", "tavily", "serper"]);
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
});
