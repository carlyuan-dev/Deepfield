import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ConfigError, createLegacyProfileManager, type ConfigSecretStore, type LegacyProfilesView } from "@deepfield/base/config/runtime";
import { AppError, type AppErrorCode, type AppErrorContext, type LlmProfileDraft, type SearchProfileDraft, type SearchProviderManifest, type SettingsView } from "@deepfield/contracts";
import { createLegacyConfigFileStore } from "./config-file-store.js";

export class ProfileStoreError extends AppError {
  constructor(message: string, code: AppErrorCode = "INTERNAL.UNKNOWN", context?: AppErrorContext, options?: ErrorOptions) {
    super(code, context, options); this.message = message; this.name = "ProfileStoreError";
  }
}

/** Desktop facade owns the file/UUID ports, Settings aggregation and public error protocol. */
export class ProfileStore {
  private readonly manager: ReturnType<typeof createLegacyProfileManager>;
  constructor(file: string, secrets: ConfigSecretStore, private readonly manifests: readonly SearchProviderManifest[] = []) {
    this.manager = createLegacyProfileManager({ documents: createLegacyConfigFileStore(file), secrets, newId: randomUUID, equalValues: isDeepStrictEqual });
  }

  private async run<T>(operation: () => Promise<T>, service?: "llm" | "search"): Promise<T> {
    try { return await operation(); }
    catch (cause) {
      let code: AppErrorCode = "INTERNAL.UNKNOWN";
      let message = "profile operation failed";
      if (cause instanceof ConfigError) {
        if (service === undefined && (cause.context?.key === "llm" || cause.context?.key === "search")) service = cause.context.key;
        switch (cause.reason) {
          case "invalid_values": case "invalid_secrets": code = "CONFIG.INVALID"; message = `invalid ${service ?? "configuration"} profile`; break;
          case "profile_not_found": case "no_active_profile": code = "CONFIG.PROFILE_MISSING"; message = `${service ?? "configuration"} profile not found`; break;
          case "missing_secret": code = "CONFIG.CREDENTIAL_MISSING"; message = `${service ?? "configuration"} credential is missing`; break;
          case "active_profile": code = "BUSINESS.CONFLICT"; message = `active ${service ?? "configuration"} profile cannot be deleted`; break;
          case "storage_failed": case "invalid_document": code = "STORAGE.FAILED"; message = "settings storage failed"; break;
          case "not_initialized": message = "profile store is not initialized"; break;
        }
      }
      throw new ProfileStoreError(message, code, service === undefined ? undefined : { service }, { cause });
    }
  }
  private settings(view: LegacyProfilesView): SettingsView {
    return { ...view, search: { ...view.search, manifests: [...this.manifests] } };
  }
  private update(operation: () => Promise<LegacyProfilesView>, service?: "llm" | "search"): Promise<SettingsView> {
    return this.run(async () => this.settings(await operation()), service);
  }

  initialize(): Promise<void> { return this.run(() => this.manager.initialize()); }
  getView(): Promise<SettingsView> { return this.update(() => this.manager.getView()); }
  saveLlmProfile(draft: LlmProfileDraft): Promise<SettingsView> { return this.update(() => this.manager.saveLlmProfile(draft), "llm"); }
  saveSearchProfile(draft: SearchProfileDraft): Promise<SettingsView> { return this.update(() => this.manager.saveSearchProfile(draft), "search"); }
  activateLlmProfile(id: string | null): Promise<SettingsView> { return this.update(() => this.manager.activateLlmProfile(id), "llm"); }
  activateSearchProfile(id: string | null): Promise<SettingsView> { return this.update(() => this.manager.activateSearchProfile(id), "search"); }
  deleteLlmProfile(id: string): Promise<SettingsView> { return this.update(() => this.manager.deleteLlmProfile(id), "llm"); }
  deleteSearchProfile(id: string): Promise<SettingsView> { return this.update(() => this.manager.deleteSearchProfile(id), "search"); }
  resolveActiveLlm() { return this.run(() => this.manager.resolveActiveLlm(), "llm"); }
  resolveActiveSearch() { return this.run(() => this.manager.resolveActiveSearch(), "search"); }
  resolveLlmDraft(draft: LlmProfileDraft) { return this.run(() => this.manager.resolveLlmDraft(draft), "llm"); }
  resolveSearchDraft(draft: SearchProfileDraft) { return this.run(() => this.manager.resolveSearchDraft(draft), "search"); }
}
