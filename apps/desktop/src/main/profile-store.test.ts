import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, makeCrypto, makeDir } from "./secret-store-test-helpers.js";
import { SecretStore } from "./secret-store.js";
import { ProfileStore, ProfileStoreError } from "./profile-store.js";

afterEach(cleanupTempDirs);
function fixture() { const root = makeDir(); const secrets = new SecretStore(join(root, "secrets.json"), makeCrypto()); return { root, secrets, store: new ProfileStore(join(root, "settings.json"), secrets) }; }
const llm = { name: "DeepSeek Flash", provider: "deepseek", protocol: "openai_compatible", baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash", contextWindow: 128_000, apiKey: "secret-value" } as const;
const search = { name: "Tavily", provider: "tavily", baseUrl: "https://api.tavily.com", options: {}, apiKey: "search-secret" } as const;

describe("ProfileStore", () => {
  it("stores only non-secret profile data and masks runtime credentials", async () => {
    const { root, store } = fixture(); await store.initialize(); const view = await store.saveLlmProfile(llm);
    expect(view.llm.profiles[0]).toMatchObject({ name: llm.name, hasCredential: true });
    expect(readFileSync(join(root, "settings.json"), "utf8")).not.toContain("secret-value");
    await store.activateLlmProfile(view.llm.profiles[0]!.id);
    expect(await store.resolveActiveLlm()).toMatchObject({ apiKey: "secret-value", modelId: llm.modelId });
  });
  it("migrates deepseek.apiKey once only when no LLM profile exists", async () => {
    const { secrets, store } = fixture(); secrets.set("deepseek.apiKey", "legacy-key"); await store.initialize(); await store.initialize();
    const view = await store.getView(); expect(view.llm.profiles).toHaveLength(1); expect(view.llm.activeProfileId).toBe(view.llm.profiles[0]!.id);
    expect((await store.resolveActiveLlm()).apiKey).toBe("legacy-key");
  });
  it("preserves omitted credentials and rejects deleting active profiles", async () => {
    const { store } = fixture(); await store.initialize(); let view = await store.saveSearchProfile(search); const profile = view.search.profiles[0]!;
    view = await store.saveSearchProfile({ ...search, id: profile.id, name: "Renamed", apiKey: undefined });
    expect(view.search.profiles[0]).toMatchObject({ name: "Renamed", hasCredential: true }); await store.activateSearchProfile(profile.id);
    await expect(store.deleteSearchProfile(profile.id)).rejects.toBeInstanceOf(ProfileStoreError); expect((await store.resolveActiveSearch()).apiKey).toBe("search-secret");
  });
});
