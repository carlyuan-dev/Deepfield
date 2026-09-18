import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import * as RootContracts from "@deepfield/contracts";
import * as ModelConfig from "@deepfield/contracts/model-config";
import * as Tools from "@deepfield/contracts/tools";
import * as Settings from "./settings.js";

describe("settings narrow-entry compatibility", () => {
  it("keeps moved schemas identical across the root, legacy and narrow entries", () => {
    const configSchemas = [
      "LlmProtocolSchema",
      "LlmProviderPresetIdSchema",
      "SearchProviderIdSchema",
      "LlmProfileDraftSchema",
      "LlmProfileViewSchema",
      "LlmRuntimeSnapshotSchema",
      "JsonOptionsSchema",
      "SearchProfileDraftSchema",
      "SearchProfileViewSchema",
      "SearchRuntimeSnapshotSchema",
      "SettingsFieldSchema",
      "SearchProviderManifestSchema",
    ] as const;
    for (const name of configSchemas) {
      expect(RootContracts[name]).toBe(ModelConfig[name]);
      expect(Settings[name]).toBe(ModelConfig[name]);
    }
    expect(RootContracts.ToolAccessPolicySchema).toBe(Tools.ToolAccessPolicySchema);
    expect(Settings.ToolAccessPolicySchema).toBe(Tools.ToolAccessPolicySchema);
  });

  it("accepts the existing runtime snapshot shapes and still rejects empty keys", () => {
    const llm = {
      id: "llm-1",
      configRevisionId: "revision-1",
      draftSessionId: "draft-1",
      name: "DeepSeek",
      provider: "deepseek",
      protocol: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-chat",
      contextWindow: 128_000,
      apiKey: "sk-test-only",
    };
    const search = {
      id: "search-1",
      configRevisionId: "revision-1",
      name: "Tavily",
      provider: "tavily",
      baseUrl: "https://api.tavily.com",
      options: { searchDepth: "advanced" },
      apiKey: "test-only",
    };
    expect(Value.Check(ModelConfig.LlmRuntimeSnapshotSchema, llm)).toBe(true);
    expect(Value.Check(ModelConfig.SearchRuntimeSnapshotSchema, search)).toBe(true);
    expect(Value.Check(ModelConfig.LlmRuntimeSnapshotSchema, { ...llm, apiKey: "" })).toBe(false);
    expect(Value.Check(ModelConfig.SearchRuntimeSnapshotSchema, { ...search, apiKey: "" })).toBe(false);
  });

  it("preserves ToolAccessPolicy bounds", () => {
    const policy = {
      network: "enabled",
      maxAgentTurns: 6,
      maxSearchCalls: 4,
      maxFetchCalls: 3,
    };
    expect(Value.Check(Tools.ToolAccessPolicySchema, policy)).toBe(true);
    expect(Value.Check(Tools.ToolAccessPolicySchema, { ...policy, maxAgentTurns: 0 })).toBe(false);
    expect(Value.Check(Tools.ToolAccessPolicySchema, { ...policy, maxSearchCalls: 101 })).toBe(false);
    expect(Value.Check(Tools.ToolAccessPolicySchema, { ...policy, maxFetchCalls: -1 })).toBe(false);
  });
});
