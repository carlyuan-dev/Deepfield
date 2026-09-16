import { describe, expect, it, vi } from "vitest";
import type { LlmRuntimeSnapshot, SearchRuntimeSnapshot } from "@deepfield/contracts";
import { ConfigurationService } from "./configuration-service.js";
import { AppError } from "@deepfield/contracts";
import { SearchProviderError } from "@deepfield/retrieval";
import { ModelGatewayError } from "../shared/model-gateway.js";

describe("ConfigurationService diagnostics", () => {
  it.each([
    [new AppError("CONFIG.CREDENTIAL_MISSING", { service: "search" }), "CONFIG.CREDENTIAL_MISSING"],
    [new SearchProviderError("unauthorized"), "EXTERNAL.AUTHENTICATION_FAILED"],
    [new SearchProviderError("timeout"), "EXTERNAL.TIMEOUT"],
    [new SearchProviderError("rate_limited"), "EXTERNAL.RATE_LIMITED"],
    [new Error("secret token unauthorized timeout"), "INTERNAL.UNKNOWN"],
  ])("preserves typed search failures without guessing from messages", async (failure, code) => {
    const service = new ConfigurationService({ resolveSearchDraft: async () => { throw failure; } } as never, {} as never);
    const result = await service.diagnoseSearch({} as never);
    expect(result).toMatchObject({ ok: false, error: { code, context: { service: "search" } } });
    expect(JSON.stringify(result)).not.toContain("secret token");
  });
  it.each([
    [new AppError("CONFIG.CREDENTIAL_MISSING", { service: "llm" }), "CONFIG.CREDENTIAL_MISSING"],
    [new ModelGatewayError(), "EXTERNAL.UNAVAILABLE"],
    [new Error("secret token"), "INTERNAL.UNKNOWN"],
  ])("keeps LLM configuration errors distinct from opaque gateway failures", async (failure, code) => {
    const service = new ConfigurationService({ resolveLlmDraft: async () => { throw failure; } } as never, {} as never);
    expect(await service.diagnoseLlm({} as never)).toMatchObject({ ok: false, error: { code, context: { service: "llm" } } });
  });
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
