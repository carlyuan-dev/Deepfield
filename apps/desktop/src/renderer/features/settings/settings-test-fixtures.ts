import type { SettingsView } from "@deepfield/contracts";

export function configuredSettings(): SettingsView {
  return {
    schemaVersion: 1,
    llm: { activeProfileId: "llm", profiles: [{ id: "llm", name: "模型", provider: "deepseek", protocol: "openai_compatible", baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash", contextWindow: 128000, hasCredential: true }] },
    search: { activeProfileId: "search", profiles: [{ id: "search", name: "搜索", provider: "tavily", baseUrl: "https://api.tavily.com", options: {}, hasCredential: true }], manifests: [] },
  };
}
