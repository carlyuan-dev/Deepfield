import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
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

function captureCompletionRequests(modelId: string): Record<string, unknown>[] {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    const chunk = {
      id: "completion-test",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: { role: "assistant", content: "Report body" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe.each(["agent stream", "completeText"] as const)("PiModelGateway %s request contract", (entrypoint) => {
  async function request(input: LlmRuntimeSnapshot): Promise<void> {
    const gateway = new PiModelGateway();
    if (entrypoint === "completeText") {
      expect(await gateway.completeText(input, "Write a report", "Research this company")).toBe("Report body");
      return;
    }
    // Chat and Capability raw use this model with Pi's streamSimple and thinking off.
    const model = gateway.createModel(input);
    const result = await streamSimple(model, {
      systemPrompt: "Write a report",
      messages: [{ role: "user", content: "Research this company", timestamp: 1 }],
    }, { apiKey: await gateway.getApiKey(input, model.provider) }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "Report body" }]);
  }

  it.each([
    ["deepseek-v4-flash", "https://api.deepseek.com"],
    ["deepseek-v4-flash", "https://llm-proxy.example.test/v1"],
    ["deepseek-future-model", "https://llm-proxy.example.test/v1"],
  ])("explicitly disables DeepSeek thinking for %s at %s without increasing the token cap", async (modelId, baseUrl) => {
    const input: LlmRuntimeSnapshot = {
      ...snapshot("openai_compatible"), provider: "deepseek", modelId, baseUrl, contextWindow: 1_000_000,
    };
    const requests = captureCompletionRequests(modelId);

    await request(input);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model: modelId, max_tokens: 8192, thinking: { type: "disabled" } });
    expect(requests[0]).not.toHaveProperty("max_completion_tokens");
    expect(requests[0]).not.toHaveProperty("reasoning_effort");
    expect(requests[0]).not.toHaveProperty("store");
    expect(requests[0]?.messages).toEqual([
      { role: "system", content: "Write a report" },
      { role: "user", content: "Research this company" },
    ]);
  });

  it.each(["openai", "qwen", "custom"] as const)("does not send DeepSeek thinking parameters for the %s provider", async (provider) => {
    const input: LlmRuntimeSnapshot = {
      ...snapshot("openai_compatible"), provider, modelId: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com",
    };
    const requests = captureCompletionRequests(input.modelId);

    await request(input);

    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("thinking");
    expect(requests[0]).not.toHaveProperty("reasoning_effort");
  });
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
