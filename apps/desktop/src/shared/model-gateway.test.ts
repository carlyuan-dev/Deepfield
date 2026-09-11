import { describe, expect, it, vi } from "vitest";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts";
import { PiModelGateway } from "./model-gateway.js";

const snapshot = (protocol: LlmRuntimeSnapshot["protocol"]): LlmRuntimeSnapshot => ({
  id: `profile-${protocol}`,
  name: protocol === "anthropic_messages" ? "Claude Custom" : "OpenAI Custom",
  provider: "custom",
  protocol,
  baseUrl: protocol === "anthropic_messages" ? "https://claude.example.test" : "https://openai.example.test/v1",
  modelId: protocol === "anthropic_messages" ? "claude-test" : "gpt-test",
  contextWindow: protocol === "anthropic_messages" ? 200_000 : 32_000,
  apiKey: "secret-value",
});

describe("PiModelGateway", () => {
  it.each([
    ["openai_compatible", "openai-completions"],
    ["anthropic_messages", "anthropic-messages"],
  ] as const)("maps %s profiles to the matching Pi protocol", (protocol, api) => {
    const createProvider = vi.fn((input: unknown) => input);
    const gateway = new PiModelGateway({
      createProvider: createProvider as never,
      createModels: vi.fn(() => ({ setProvider: vi.fn() })) as never,
      openAICompletionsApi: vi.fn(() => ({ stream: vi.fn(), streamSimple: vi.fn() })) as never,
      anthropicMessagesApi: vi.fn(() => ({ stream: vi.fn(), streamSimple: vi.fn() })) as never,
    });
    const input = snapshot(protocol);

    const model = gateway.createModel(input);

    expect(model).toMatchObject({
      id: input.modelId,
      name: input.name,
      provider: `deepfield-${input.id}`,
      baseUrl: input.baseUrl,
      api,
      contextWindow: input.contextWindow,
      maxTokens: protocol === "anthropic_messages" ? 8192 : 4000,
    });
    expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: `deepfield-${input.id}`,
      baseUrl: input.baseUrl,
      models: [model],
    }));
  });
});
