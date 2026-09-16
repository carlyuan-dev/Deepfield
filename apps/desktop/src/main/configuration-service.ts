import { AppError, toPublicError, type AppErrorCode, type DiagnosticResult, type LlmProfileDraft, type SearchProfileDraft, type SettingsView } from "@deepfield/contracts";
import { createSearchProvider, SearchProviderError, type SearchProvider } from "@deepfield/retrieval";
import { ModelGatewayError, type ModelGateway } from "../shared/model-gateway.js";
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
    } catch (error) { return this.diagnosticFailure(error, "llm", started); }
  }

  async diagnoseSearch(input: SearchProfileDraft): Promise<DiagnosticResult> {
    const started = this.now();
    try {
      const snapshot = await this.store.resolveSearchDraft(input);
      await this.providerFactory(snapshot).search({ query: "Deepfield connection test", maxResults: 1 }, new AbortController().signal);
      return { ok: true, latencyMs: Math.max(0, this.now() - started), summary: "搜索连接正常" };
    } catch (error) {
      return this.diagnosticFailure(error, "search", started);
    }
  }
  private diagnosticFailure(error: unknown, service: "llm" | "search", started: number): DiagnosticResult {
    let normalized = toPublicError(error);
    if (error instanceof SearchProviderError) {
      const codes: Partial<Record<SearchProviderError["code"], AppErrorCode>> = {
        unauthorized: "EXTERNAL.AUTHENTICATION_FAILED", timeout: "EXTERNAL.TIMEOUT",
        rate_limited: "EXTERNAL.RATE_LIMITED", invalid_request: "CONFIG.INVALID",
      };
      normalized = toPublicError(new AppError(codes[error.code] ?? "EXTERNAL.UNAVAILABLE"));
    } else if (error instanceof ModelGatewayError) {
      // Pi exposes an opaque failure, not a trustworthy HTTP/authentication reason.
      normalized = toPublicError(new AppError("EXTERNAL.UNAVAILABLE"));
    }
    normalized.context = { service };
    // Legacy fields retained for existing consumers; UI wording uses only error identity.
    const code = normalized.code === "EXTERNAL.AUTHENTICATION_FAILED" ? "unauthorized"
      : normalized.code === "EXTERNAL.TIMEOUT" ? "network"
      : normalized.category === "configuration" ? "invalid_config" : "provider_error";
    return { ok: false, latencyMs: Math.max(0, this.now() - started), code, message: "连接不可用", error: normalized };
  }
}
