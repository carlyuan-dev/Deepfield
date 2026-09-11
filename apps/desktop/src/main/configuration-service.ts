import type { DiagnosticResult, LlmProfileDraft, SearchProfileDraft, SettingsView } from "@deepfield/contracts";
import { createSearchProvider, SearchProviderError, type SearchProvider } from "@deepfield/retrieval";
import type { ModelGateway } from "../shared/model-gateway.js";
import type { ProfileStore } from "./profile-store.js";

type ProfileConfigurationStore = Pick<ProfileStore, "getView" | "saveLlmProfile" | "activateLlmProfile" | "deleteLlmProfile" | "saveSearchProfile" | "activateSearchProfile" | "deleteSearchProfile" | "resolveLlmDraft" | "resolveSearchDraft">;

export class ConfigurationService {
  constructor(
    private readonly store: ProfileConfigurationStore,
    private readonly gateway: ModelGateway,
    private readonly providerFactory: (snapshot: Awaited<ReturnType<ProfileStore["resolveSearchDraft"]>>) => SearchProvider = createSearchProvider,
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<SettingsView> { return this.store.getView(); }
  saveLlmProfile(input: LlmProfileDraft): Promise<SettingsView> { return this.store.saveLlmProfile(input); }
  activateLlmProfile(id: string | null): Promise<SettingsView> { return this.store.activateLlmProfile(id); }
  deleteLlmProfile(id: string): Promise<SettingsView> { return this.store.deleteLlmProfile(id); }
  saveSearchProfile(input: SearchProfileDraft): Promise<SettingsView> { return this.store.saveSearchProfile(input); }
  activateSearchProfile(id: string | null): Promise<SettingsView> { return this.store.activateSearchProfile(id); }
  deleteSearchProfile(id: string): Promise<SettingsView> { return this.store.deleteSearchProfile(id); }

  async diagnoseLlm(input: LlmProfileDraft): Promise<DiagnosticResult> {
    const started = this.now();
    try {
      const snapshot = await this.store.resolveLlmDraft(input);
      await this.gateway.completeText(snapshot, "只回复 OK。", "Deepfield connection test");
      return { ok: true, latencyMs: Math.max(0, this.now() - started), summary: "模型连接正常" };
    } catch { return { ok: false, latencyMs: Math.max(0, this.now() - started), code: "invalid_config", message: "模型配置或连接不可用" }; }
  }

  async diagnoseSearch(input: SearchProfileDraft): Promise<DiagnosticResult> {
    const started = this.now();
    try {
      const snapshot = await this.store.resolveSearchDraft(input);
      await this.providerFactory(snapshot).search({ query: "Deepfield connection test", maxResults: 1 }, new AbortController().signal);
      return { ok: true, latencyMs: Math.max(0, this.now() - started), summary: "搜索连接正常" };
    } catch (error) {
      const code = error instanceof SearchProviderError
        ? error.code === "unauthorized" ? "unauthorized" : error.code === "network_unavailable" || error.code === "timeout" ? "network" : "provider_error"
        : "invalid_config";
      return { ok: false, latencyMs: Math.max(0, this.now() - started), code, message: "搜索配置或连接不可用" };
    }
  }
}
