import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts";
import { ModelGatewayError, PiModelGateway, classifyModelGatewayError } from "./model-gateway.js";

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

function captureCompletionRequests(modelId: string, finishReason = "stop"): Record<string, unknown>[] {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    const chunk = {
      id: "completion-test",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta: { role: "assistant", content: "Report body" }, finish_reason: finishReason }],
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
    ["deepseek-flash", "https://api.deepseek.com"],
    ["deepseek-flash", "https://llm-proxy.example.test/v1"],
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
      ...snapshot("openai_compatible"), provider, modelId: "deepseek-flash", baseUrl: "https://api.deepseek.com",
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
    [429, "rate_limit", true],
    [401, "authentication", false],
  ] as const)("captures HTTP %s through the SDK fetch option without exposing adapter text", async (status, category, retryable) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("provider secret response", { status })));
    let receivedFetch: typeof fetch | undefined;
    const completeSimple = vi.fn(async (_model, _context, options) => {
      receivedFetch = options.fetch;
      await options.fetch("https://llm.example.test/v1/chat/completions");
      return {
        role: "assistant", content: [], stopReason: "error",
        errorMessage: "adapter stringified provider secret response",
        timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
    });
    const gateway = new PiModelGateway({
      createModels: vi.fn(() => ({ setProvider: vi.fn(), completeSimple })) as never,
      createProvider: vi.fn((value) => value) as never,
      openAICompletionsApi: vi.fn(() => ({})) as never,
      anthropicMessagesApi: vi.fn(() => ({})) as never,
    });

    const failure = await gateway.completeText(snapshot("openai_compatible"), "system", "prompt").catch((error: unknown) => error);

    expect(receivedFetch).toBeTypeOf("function");
    expect(failure).toMatchObject({ message: "model request failed", category, retryable });
    expect(String(failure)).not.toContain("provider secret");
  });
  it("classifies only bounded status, network, and timeout shapes as retryable without retaining messages", () => {
    expect(classifyModelGatewayError({ status: 429 })).toMatchObject({ category: "rate_limit", retryable: true });
    expect(classifyModelGatewayError({ statusCode: 503 })).toMatchObject({ category: "server", retryable: true });
    expect(classifyModelGatewayError({ code: "ECONNRESET" })).toMatchObject({ category: "network", retryable: true });
    expect(classifyModelGatewayError({ status: 401, message: "secret provider text" })).toEqual(new ModelGatewayError("authentication", false));
    expect(classifyModelGatewayError({ status: 400 })).toMatchObject({ category: "request", retryable: false });
    expect(classifyModelGatewayError(new Error("arbitrary provider failure"))).toMatchObject({ category: "unknown", retryable: false, message: "model request failed" });
  });
  it("returns the provider length stop reason through the optional metadata path", async () => {
    const input = snapshot("openai_compatible");
    captureCompletionRequests(input.modelId, "length");

    await expect(new PiModelGateway().completeTextResult(input, "system", "prompt")).resolves.toEqual({
      text: "Report body", stopReason: "length",
    });
  });

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
