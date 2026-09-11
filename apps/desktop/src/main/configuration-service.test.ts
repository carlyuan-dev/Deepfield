import { describe, expect, it, vi } from "vitest";
import type { LlmRuntimeSnapshot, SearchRuntimeSnapshot } from "@deepfield/contracts";
import { ConfigurationService } from "./configuration-service.js";

describe("ConfigurationService diagnostics", () => {
  it("diagnoses unsaved drafts with their existing credentials without saving", async () => {
    const llm: LlmRuntimeSnapshot = { id: "l1", name: "LLM", provider: "custom", protocol: "openai_compatible", baseUrl: "https://llm.test/v1", modelId: "m", contextWindow: 32000, apiKey: "llm-secret" };
    const search: SearchRuntimeSnapshot = { id: "s1", name: "Search", provider: "zhipu", baseUrl: "https://search.test/v4", options: { searchEngine: "search_std" }, apiKey: "search-secret" };
    const store = {
      resolveLlmDraft: vi.fn(async () => llm), resolveSearchDraft: vi.fn(async () => search),
      saveLlmProfile: vi.fn(), saveSearchProfile: vi.fn(), getView: vi.fn(), activateLlmProfile: vi.fn(), activateSearchProfile: vi.fn(), deleteLlmProfile: vi.fn(), deleteSearchProfile: vi.fn(),
    };
    const gateway = { completeText: vi.fn(async () => "OK") };
    const provider = { search: vi.fn(async () => ({ provider: "zhipu", results: [] })) };
    const service = new ConfigurationService(store as never, gateway as never, vi.fn(() => provider as never));

    await expect(service.diagnoseLlm({ ...llm, apiKey: undefined } as never)).resolves.toMatchObject({ ok: true });
    await expect(service.diagnoseSearch({ ...search, apiKey: undefined } as never)).resolves.toMatchObject({ ok: true });
    expect(gateway.completeText).toHaveBeenCalledWith(llm, "只回复 OK。", "Deepfield connection test");
    expect(provider.search).toHaveBeenCalledWith({ query: "Deepfield connection test", maxResults: 1 }, expect.any(AbortSignal));
    expect(store.saveLlmProfile).not.toHaveBeenCalled();
    expect(store.saveSearchProfile).not.toHaveBeenCalled();
  });
});
