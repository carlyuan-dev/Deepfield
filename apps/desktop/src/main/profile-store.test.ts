import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createLegacyProfileManager } from "@deepfield/base/config/runtime";
import { cleanupTempDirs, makeCrypto, makeDir } from "./secret-store-test-helpers.js";
import { SecretStore } from "./secret-store.js";
import { ProfileStore, ProfileStoreError } from "./profile-store.js";

afterEach(cleanupTempDirs);
function fixture() { const root = makeDir(); const secrets = new SecretStore(join(root, "secrets.json"), makeCrypto()); return { root, secrets, store: new ProfileStore(join(root, "settings.json"), secrets) }; }
const llm = { name: "DeepSeek Flash", provider: "deepseek", protocol: "openai_compatible", baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash", contextWindow: 128_000, apiKey: "secret-value" } as const;
const search = { name: "Tavily", provider: "tavily", baseUrl: "https://api.tavily.com", options: {}, apiKey: "search-secret" } as const;

describe("ProfileStore", () => {
  it("keeps permissive Search option keys and revises changes even when their values are undefined", async () => {
    const { store } = fixture(); await store.initialize();
    const options = { conditional: undefined, constructor: "provider-owned" };
    const diagnostic = await store.resolveSearchDraft({ ...search, options });
    expect(diagnostic.options).toEqual(options);
    expect(Object.hasOwn(diagnostic.options, "conditional")).toBe(true);
    const saved = await store.saveSearchProfile({ ...search, options: { first: undefined } });
    const id = saved.search.profiles[0]!.id; await store.activateSearchProfile(id);
    const previous = await store.resolveActiveSearch();
    await store.saveSearchProfile({ ...search, id, options: { second: undefined } });
    const next = await store.resolveActiveSearch();
    expect(next.options).toEqual({ second: undefined });
    expect(Object.hasOwn(next.options, "second")).toBe(true);
    expect(next.configRevisionId).not.toBe(previous.configRevisionId);
  });

  it("saves and activates missing-key profiles but reports the established execution error", async () => {
    const { store } = fixture(); await store.initialize();
    const { apiKey: _key, ...draft } = search;
    const view = await store.saveSearchProfile(draft);
    expect(view.search.profiles[0]?.hasCredential).toBe(false);
    await store.activateSearchProfile(view.search.profiles[0]!.id);
    await expect(store.resolveActiveSearch()).rejects.toMatchObject({ code: "CONFIG.CREDENTIAL_MISSING", context: { service: "search" } });
    await expect(store.saveSearchProfile({ ...draft, apiKey: "" })).rejects.toMatchObject({ code: "CONFIG.INVALID", context: { service: "search" } });
  });

  it("keeps legacy DeepSeek credentials after deletion so a later initialization can import them", async () => {
    const { store, secrets, root } = fixture(); secrets.set("deepseek.apiKey", "legacy-key");
    await store.initialize();
    const original = (await store.getView()).llm.profiles[0]!;
    await store.activateLlmProfile(null); await store.deleteLlmProfile(original.id);
    expect(secrets.get("deepseek.apiKey")).toBe("legacy-key");
    const reopened = new ProfileStore(join(root, "settings.json"), secrets); await reopened.initialize();
    const restored = await reopened.resolveActiveLlm();
    expect(restored.id).not.toBe(original.id); expect(restored.apiKey).toBe("legacy-key");
  });

  it("fills missing revisions without changing persisted profile and credential identities", async () => {
    const { store, root, secrets } = fixture(); await store.initialize();
    const saved = await store.saveSearchProfile(search); await store.activateSearchProfile(saved.search.profiles[0]!.id);
    const file = join(root, "settings.json");
    const before = JSON.parse(readFileSync(file, "utf8")); delete before.search.profiles[0].configRevisionId;
    writeFileSync(file, JSON.stringify(before));
    const reopened = new ProfileStore(file, secrets); await reopened.initialize();
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.search.profiles[0].configRevisionId).toMatch(/^[a-f0-9-]{36}$/);
    delete after.search.profiles[0].configRevisionId;
    expect(after).toEqual(before);
  });

  it("reports a failed document write after the secret write without exposing the key", async () => {
    const { root, secrets } = fixture();
    const blocked = join(root, "blocked");
    const store = new ProfileStore(join(blocked, "settings.json"), secrets); await store.initialize();
    writeFileSync(blocked, "not a directory");
    const error = await store.saveSearchProfile(search).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ProfileStoreError);
    expect(error).toMatchObject({ code: "STORAGE.FAILED", context: { service: "search" }, cause: expect.any(Error) });
    expect(String(error)).not.toContain(search.apiKey); expect(JSON.stringify(error)).not.toContain(search.apiKey);
  });

  it("preserves secret-before-document ordering and propagates injected partial-write failures", async () => {
    let document: unknown; let nextId = 0; let fail = false;
    const calls: string[] = [], secrets = new Map<string, string>();
    const cause = new Error("document write failed search-secret");
    const manager = createLegacyProfileManager({ newId: () => `profile-${++nextId}`, equalValues: isDeepStrictEqual,
      documents: { read: () => document, write: (value) => { calls.push("write"); if (fail) throw cause; document = structuredClone(value); } },
      secrets: { has: (ref) => secrets.has(ref), get: (ref) => secrets.get(ref),
        set: (ref, value) => { calls.push("set"); secrets.set(ref, value); },
        delete: (ref) => { calls.push("delete"); secrets.delete(ref); },
      },
    });
    await manager.initialize();
    const saved = await manager.saveSearchProfile(search); const id = saved.search.profiles[0]!.id;
    const before = structuredClone(document);
    expect(calls).toEqual(["set", "write"]);
    fail = true; calls.length = 0;
    const error = await manager.saveSearchProfile({ ...search, id, apiKey: "new-test-key" }).catch((error: unknown) => error);
    expect(error).toMatchObject({ reason: "storage_failed" });
    expect(String(error)).not.toContain(search.apiKey); expect(JSON.stringify(error)).not.toContain(search.apiKey);
    expect(calls).toEqual(["set", "write"]); expect(document).toEqual(before);
    expect([...secrets.values()]).toEqual(["new-test-key"]);
    calls.length = 0;
    await expect(manager.deleteSearchProfile(id)).rejects.toMatchObject({ reason: "storage_failed" });
    expect(calls).toEqual(["delete", "write"]); expect(document).toEqual(before);
    expect(secrets.size).toBe(0);
  });

  it.each(["draft", "view", "snapshot", "diagnostic"])("isolates nested Search options from %s mutation", async (boundary) => {
    const { store, root } = fixture(); await store.initialize();
    const options = { nested: { list: ["original"] } };
    const saved = await store.saveSearchProfile({ ...search, options });
    const id = saved.search.profiles[0]!.id;
    await store.activateSearchProfile(id);
    const original = await store.resolveActiveSearch();
    const before = readFileSync(join(root, "settings.json"), "utf8");
    if (boundary === "draft") options.nested.list.push("changed");
    if (boundary === "view") (saved.search.profiles[0]!.options as typeof options).nested.list.push("changed");
    if (boundary === "snapshot") (original.options as typeof options).nested.list.push("changed");
    if (boundary === "diagnostic") {
      const diagnostic = await store.resolveSearchDraft({ ...search, id, options });
      (diagnostic.options as typeof options).nested.list.push("changed");
      expect(options).toEqual({ nested: { list: ["original"] } });
    }
    expect((await store.resolveActiveSearch()).options).toEqual({ nested: { list: ["original"] } });
    expect((await store.resolveActiveSearch()).configRevisionId).toBe(original.configRevisionId);
    expect(readFileSync(join(root, "settings.json"), "utf8")).toBe(before);
  });

  it("allows explicit-key diagnostics for an unknown id but refuses saving it", async () => {
    const { store } = fixture(); await store.initialize();
    expect(await store.resolveSearchDraft({ ...search, id: "unknown" })).toMatchObject({ id: "unknown", apiKey: search.apiKey });
    expect(await store.resolveLlmDraft({ ...llm, id: "unknown" })).toMatchObject({ id: "unknown", apiKey: llm.apiKey });
    await expect(store.saveSearchProfile({ ...search, id: "unknown" })).rejects.toMatchObject({ code: "CONFIG.PROFILE_MISSING" });
    await expect(store.saveLlmProfile({ ...llm, id: "unknown" })).rejects.toMatchObject({ code: "CONFIG.PROFILE_MISSING" });
  });

  it("persists opaque revisions only on actual config/key changes and keeps draft identity separate", async () => {
    const { root, store, secrets } = fixture(); await store.initialize();
    const view = await store.saveLlmProfile(llm); const id = view.llm.profiles[0]!.id;
    await store.activateLlmProfile(id);
    const original = await store.resolveActiveLlm();
    expect(original.configRevisionId).toMatch(/^[a-f0-9-]{36}$/);
    await store.saveLlmProfile({ ...llm, id });
    expect((await store.resolveActiveLlm()).configRevisionId).toBe(original.configRevisionId);
    await store.saveLlmProfile({ ...llm, id, apiKey: "new-secret" });
    const changed = await store.resolveActiveLlm();
    expect(changed.configRevisionId).not.toBe(original.configRevisionId);
    const reopened = new ProfileStore(join(root, "settings.json"), secrets); await reopened.initialize();
    expect((await reopened.resolveActiveLlm()).configRevisionId).toBe(changed.configRevisionId);
    const draft = await store.resolveLlmDraft({ ...llm, id });
    expect(draft.draftSessionId).toBeTypeOf("string");
    expect(draft.configRevisionId).not.toBe(changed.configRevisionId);
    expect(readFileSync(join(root, "settings.json"), "utf8")).not.toContain("new-secret");
  });
  it("resolves unsaved Doubao search drafts and persists them with independent search credentials", async () => {
    const { root, secrets, store } = fixture();
    await store.initialize();
    const draft = { name: "豆包搜索 Custom", provider: "doubao" as const, baseUrl: "https://open.feedcoopapi.com", options: {}, apiKey: "doubao-search-secret" };
    expect(await store.resolveSearchDraft(draft)).toMatchObject(draft);
    expect((await store.getView()).search.profiles).toEqual([]);
    const view = await store.saveSearchProfile(draft);
    await store.activateSearchProfile(view.search.profiles[0]!.id);
    const reopened = new ProfileStore(join(root, "settings.json"), secrets);
    await reopened.initialize();
    expect(await reopened.resolveActiveSearch()).toMatchObject(draft);
    expect((await reopened.getView()).llm.profiles).toEqual([]);
    expect(readFileSync(join(root, "settings.json"), "utf8")).not.toContain(draft.apiKey);
  });
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
    expect((await store.resolveActiveLlm()).modelId).toBe("deepseek-flash");
  });
  it("migrates only saved DeepSeek Flash legacy IDs and preserves profile data and credentials across restart", async () => {
    const { root, secrets, store } = fixture();
    await store.initialize();
    const legacy = { ...llm, modelId: "deepseek-v4-flash" };
    const profiles = [
      { ...legacy, name: "Active legacy" },
      { ...legacy, name: "Inactive legacy", baseUrl: "https://proxy.test/v1" },
      { ...llm, modelId: "deepseek-v4-flash-custom" },
      { ...llm, modelId: "deepseek-flash" },
      { ...llm, modelId: "my-custom-model" },
      { ...legacy, provider: "custom" as const },
      { ...legacy, provider: "qwen" as const },
      { ...legacy, protocol: "anthropic_messages" as const },
    ];
    for (const profile of profiles) await store.saveLlmProfile(profile);
    const initial = await store.getView();
    await store.activateLlmProfile(initial.llm.profiles[0]!.id);
    const searchView = await store.saveSearchProfile(search);
    await store.activateSearchProfile(searchView.search.profiles[0]!.id);
    const settingsPath = join(root, "settings.json");
    const before = JSON.parse(readFileSync(settingsPath, "utf8"));
    const secretsBefore = readFileSync(join(root, "secrets.json"), "utf8");
    const reopened = new ProfileStore(settingsPath, secrets);

    await reopened.initialize();

    const expected = structuredClone(before);
    expected.llm.profiles[0].modelId = "deepseek-flash";
    expected.llm.profiles[1].modelId = "deepseek-flash";
    const migrated = JSON.parse(readFileSync(settingsPath, "utf8"));
    for (const index of [0, 1]) {
      expect(migrated.llm.profiles[index].configRevisionId).not.toBe(before.llm.profiles[index].configRevisionId);
      expected.llm.profiles[index].configRevisionId = migrated.llm.profiles[index].configRevisionId;
    }
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(expected);
    expect((await reopened.getView()).llm.profiles.map((profile) => profile.modelId)).toEqual([
      "deepseek-flash", "deepseek-flash", "deepseek-v4-flash-custom", "deepseek-flash",
      "my-custom-model", "deepseek-v4-flash", "deepseek-v4-flash", "deepseek-v4-flash",
    ]);
    expect(await reopened.resolveActiveLlm()).toMatchObject({
      id: initial.llm.profiles[0]!.id, modelId: "deepseek-flash", apiKey: "secret-value",
    });
    expect((await reopened.resolveActiveSearch()).apiKey).toBe("search-secret");
    expect(readFileSync(join(root, "secrets.json"), "utf8")).toBe(secretsBefore);
    const restarted = new ProfileStore(settingsPath, secrets);
    await restarted.initialize();
    expect(await restarted.getView()).toEqual(await reopened.getView());
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(expected);
  });
  it("rejects settings files that do not match the strict version-1 schema", async () => {
    const { root, secrets } = fixture();
    writeFileSync(join(root, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      llm: { activeProfileId: null, profiles: [] },
      search: { activeProfileId: null, profiles: [] },
      apiKey: "must-not-be-accepted",
    }));
    const store = new ProfileStore(join(root, "settings.json"), secrets);
    await expect(store.initialize()).rejects.toBeInstanceOf(ProfileStoreError);
  });
  it("preserves omitted credentials and rejects deleting active profiles", async () => {
    const { store } = fixture(); await store.initialize(); let view = await store.saveSearchProfile(search); const profile = view.search.profiles[0]!;
    const { apiKey: _apiKey, ...searchWithoutKey } = search;
    view = await store.saveSearchProfile({ ...searchWithoutKey, id: profile.id, name: "Renamed" });
    expect(view.search.profiles[0]).toMatchObject({ name: "Renamed", hasCredential: true }); await store.activateSearchProfile(profile.id);
    await expect(store.deleteSearchProfile(profile.id)).rejects.toBeInstanceOf(ProfileStoreError); expect((await store.resolveActiveSearch()).apiKey).toBe("search-secret");
  });
});
