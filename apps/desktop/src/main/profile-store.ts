import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { DEFAULT_DEEPSEEK_MODEL_ID, LlmProfileDraftSchema, LlmProtocolSchema, LlmProviderPresetIdSchema, SearchProfileDraftSchema, SearchProviderIdSchema, type LlmProfileDraft, type LlmProfileView, type LlmRuntimeSnapshot, type SearchProfileDraft, type SearchProfileView, type SearchProviderManifest, type SearchRuntimeSnapshot, type SettingsView } from "@deepfield/contracts";

interface Secrets { has(name: string): boolean; get(name: string): string | undefined; set(name: string, value: string): void; delete(name: string): void }
interface StoredLlm extends Omit<LlmProfileView, "hasCredential"> { credentialRef: string }
interface StoredSearch extends Omit<SearchProfileView, "hasCredential"> { credentialRef: string }
interface StoredSettings { schemaVersion: 1; llm: { activeProfileId: string | null; profiles: StoredLlm[] }; search: { activeProfileId: string | null; profiles: StoredSearch[] } }
const StoredIdSchema = Type.String({ minLength: 1, maxLength: 200 });
const StoredHttpsUrlSchema = Type.String({ pattern: "^https://", maxLength: 2000 });
const StoredLlmSchema = Type.Object({
  id: StoredIdSchema,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  provider: LlmProviderPresetIdSchema,
  protocol: LlmProtocolSchema,
  baseUrl: StoredHttpsUrlSchema,
  modelId: Type.String({ minLength: 1, maxLength: 200 }),
  contextWindow: Type.Integer({ minimum: 1024, maximum: 10_000_000 }),
  credentialRef: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false });
const StoredSearchSchema = Type.Object({
  id: StoredIdSchema,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  provider: SearchProviderIdSchema,
  baseUrl: StoredHttpsUrlSchema,
  options: Type.Record(Type.String(), Type.Unknown()),
  credentialRef: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false });
const StoredSettingsSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  llm: Type.Object({
    activeProfileId: Type.Union([StoredIdSchema, Type.Null()]),
    profiles: Type.Array(StoredLlmSchema),
  }, { additionalProperties: false }),
  search: Type.Object({
    activeProfileId: Type.Union([StoredIdSchema, Type.Null()]),
    profiles: Type.Array(StoredSearchSchema),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
const empty = (): StoredSettings => ({ schemaVersion: 1, llm: { activeProfileId: null, profiles: [] }, search: { activeProfileId: null, profiles: [] } });
export class ProfileStoreError extends Error { constructor(message: string) { super(message); this.name = "ProfileStoreError"; } }

export class ProfileStore {
  private settings: StoredSettings = empty(); private initialized = false;
  constructor(private readonly file: string, private readonly secrets: Secrets, private readonly manifests: readonly SearchProviderManifest[] = []) {}
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (existsSync(this.file)) {
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(this.file, "utf8")); }
      catch { throw new ProfileStoreError("settings are corrupted"); }
      if (!Value.Check(StoredSettingsSchema, parsed)) throw new ProfileStoreError("settings are corrupted");
      this.settings = parsed;
      let migrated = false;
      for (const profile of this.settings.llm.profiles) {
        if (profile.provider === "deepseek" && profile.protocol === "openai_compatible" && profile.modelId === "deepseek-v4-flash") {
          profile.modelId = DEFAULT_DEEPSEEK_MODEL_ID;
          migrated = true;
        }
      }
      if (migrated) this.write();
    }
    if (this.settings.llm.profiles.length === 0 && this.secrets.has("deepseek.apiKey")) {
      const id = randomUUID(); this.settings.llm.profiles.push({ id, name: "DeepSeek", provider: "deepseek", protocol: "openai_compatible", baseUrl: "https://api.deepseek.com", modelId: DEFAULT_DEEPSEEK_MODEL_ID, contextWindow: 128000, credentialRef: "deepseek.apiKey" }); this.settings.llm.activeProfileId = id; this.write();
    }
    this.initialized = true;
  }
  private write(): void { mkdirSync(dirname(this.file), { recursive: true }); const temp = `${this.file}.${randomUUID()}.tmp`; writeFileSync(temp, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 }); renameSync(temp, this.file); }
  private ensure(): void { if (!this.initialized) throw new ProfileStoreError("profile store is not initialized"); }
  async getView(): Promise<SettingsView> { this.ensure(); return { schemaVersion: 1, llm: { activeProfileId: this.settings.llm.activeProfileId, profiles: this.settings.llm.profiles.map((p) => { const { credentialRef, ...view } = p; return { ...view, hasCredential: this.secrets.has(credentialRef) }; }) }, search: { activeProfileId: this.settings.search.activeProfileId, profiles: this.settings.search.profiles.map((p) => { const { credentialRef, ...view } = p; return { ...view, hasCredential: this.secrets.has(credentialRef) }; }), manifests: [...this.manifests] } }; }
  async saveLlmProfile(draft: LlmProfileDraft): Promise<SettingsView> { this.ensure(); if (!Value.Check(LlmProfileDraftSchema, draft)) throw new ProfileStoreError("invalid llm profile"); const current = draft.id ? this.settings.llm.profiles.find((p) => p.id === draft.id) : undefined; if (draft.id && !current) throw new ProfileStoreError("llm profile not found"); const id = current?.id ?? randomUUID(); const credentialRef = current?.credentialRef ?? `llm.profile.${id}.apiKey`; if (draft.apiKey !== undefined) this.secrets.set(credentialRef, draft.apiKey); const stored = { id, name: draft.name, provider: draft.provider, protocol: draft.protocol, baseUrl: draft.baseUrl, modelId: draft.modelId, contextWindow: draft.contextWindow, credentialRef }; if (current) this.settings.llm.profiles.splice(this.settings.llm.profiles.indexOf(current), 1, stored); else this.settings.llm.profiles.push(stored); this.write(); return this.getView(); }
  async saveSearchProfile(draft: SearchProfileDraft): Promise<SettingsView> { this.ensure(); if (!Value.Check(SearchProfileDraftSchema, draft)) throw new ProfileStoreError("invalid search profile"); const current = draft.id ? this.settings.search.profiles.find((p) => p.id === draft.id) : undefined; if (draft.id && !current) throw new ProfileStoreError("search profile not found"); const id = current?.id ?? randomUUID(); const credentialRef = current?.credentialRef ?? `search.profile.${id}.apiKey`; if (draft.apiKey !== undefined) this.secrets.set(credentialRef, draft.apiKey); const stored = { id, name: draft.name, provider: draft.provider, baseUrl: draft.baseUrl, options: draft.options, credentialRef }; if (current) this.settings.search.profiles.splice(this.settings.search.profiles.indexOf(current), 1, stored); else this.settings.search.profiles.push(stored); this.write(); return this.getView(); }
  async activateLlmProfile(id: string | null): Promise<SettingsView> { this.ensure(); if (id !== null && !this.settings.llm.profiles.some((p) => p.id === id)) throw new ProfileStoreError("llm profile not found"); this.settings.llm.activeProfileId = id; this.write(); return this.getView(); }
  async activateSearchProfile(id: string | null): Promise<SettingsView> { this.ensure(); if (id !== null && !this.settings.search.profiles.some((p) => p.id === id)) throw new ProfileStoreError("search profile not found"); this.settings.search.activeProfileId = id; this.write(); return this.getView(); }
  async deleteLlmProfile(id: string): Promise<SettingsView> { this.ensure(); if (this.settings.llm.activeProfileId === id) throw new ProfileStoreError("active llm profile cannot be deleted"); const i = this.settings.llm.profiles.findIndex((p) => p.id === id); if (i < 0) throw new ProfileStoreError("llm profile not found"); const [p] = this.settings.llm.profiles.splice(i, 1); if (p!.credentialRef !== "deepseek.apiKey") this.secrets.delete(p!.credentialRef); this.write(); return this.getView(); }
  async deleteSearchProfile(id: string): Promise<SettingsView> { this.ensure(); if (this.settings.search.activeProfileId === id) throw new ProfileStoreError("active search profile cannot be deleted"); const i = this.settings.search.profiles.findIndex((p) => p.id === id); if (i < 0) throw new ProfileStoreError("search profile not found"); this.secrets.delete(this.settings.search.profiles.splice(i, 1)[0]!.credentialRef); this.write(); return this.getView(); }
  async resolveActiveLlm(): Promise<LlmRuntimeSnapshot> { this.ensure(); const p = this.settings.llm.profiles.find((x) => x.id === this.settings.llm.activeProfileId); if (!p) throw new ProfileStoreError("no active llm profile"); const apiKey = this.secrets.get(p.credentialRef); if (!apiKey) throw new ProfileStoreError("active llm credential is missing"); const { credentialRef: _, ...view } = p; return { ...view, apiKey }; }
  async resolveActiveSearch(): Promise<SearchRuntimeSnapshot> { this.ensure(); const p = this.settings.search.profiles.find((x) => x.id === this.settings.search.activeProfileId); if (!p) throw new ProfileStoreError("no active search profile"); const apiKey = this.secrets.get(p.credentialRef); if (!apiKey) throw new ProfileStoreError("active search credential is missing"); const { credentialRef: _, ...view } = p; return { ...view, apiKey }; }
  async resolveLlmDraft(draft: LlmProfileDraft): Promise<LlmRuntimeSnapshot> { this.ensure(); if (!Value.Check(LlmProfileDraftSchema, draft)) throw new ProfileStoreError("invalid llm profile"); const saved = draft.id ? this.settings.llm.profiles.find((p) => p.id === draft.id) : undefined; const apiKey = draft.apiKey ?? (saved ? this.secrets.get(saved.credentialRef) : undefined); if (!apiKey) throw new ProfileStoreError("llm credential is missing"); return { id: draft.id ?? randomUUID(), name: draft.name, provider: draft.provider, protocol: draft.protocol, baseUrl: draft.baseUrl, modelId: draft.modelId, contextWindow: draft.contextWindow, apiKey }; }
  async resolveSearchDraft(draft: SearchProfileDraft): Promise<SearchRuntimeSnapshot> { this.ensure(); if (!Value.Check(SearchProfileDraftSchema, draft)) throw new ProfileStoreError("invalid search profile"); const saved = draft.id ? this.settings.search.profiles.find((p) => p.id === draft.id) : undefined; const apiKey = draft.apiKey ?? (saved ? this.secrets.get(saved.credentialRef) : undefined); if (!apiKey) throw new ProfileStoreError("search credential is missing"); return { id: draft.id ?? randomUUID(), name: draft.name, provider: draft.provider, baseUrl: draft.baseUrl, options: draft.options, apiKey }; }
}
