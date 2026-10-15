import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts";
import { ModelGatewayError, PiModelGateway, classifyModelGatewayError } from "./model-gateway.js";
import type { ModelRequestObservation } from "@deepfield/capability-sdk";
import type { ObservedStreamOptions } from "./model-request-observation.js";
import { ConfigurationService } from "../main/configuration-service.js";
import { createPiChatInteractionTools } from "../worker/tools/pi-chat-interaction-tools.js";
import { Check } from "typebox/value";

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
      choices: [{ index: 0, delta: finishReason === "tool_calls"
        ? { role: "assistant", tool_calls: [{ index: 0, id: "provider-call", type: "function", function: { name: "request_user_input", arguments: '{"question":"confirm?"}' } }] }
        : { role: "assistant", content: "Report body" }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe.each(["openai_compatible", "anthropic_messages"] as const)("optional serialized observation %s", protocol => {
  it("keeps a prepared request distinct from dispatch when cancelled before sending", async () => {
    const input = snapshot(protocol);
    const gateway = new PiModelGateway();
    const model = gateway.createModel(input);
    const events: ModelRequestObservation[] = [];
    const abort = new AbortController();
    const fetch = vi.fn(async () => new Response("must not send"));
    const stream = gateway.createStream(input, event => { events.push(event); if (event.state === "prepared") abort.abort(); });
    await stream(model, { messages: [{ role: "user", content: "材料", timestamp: 1 }] }, { apiKey: "fixture", signal: abort.signal, fetch, requestObservation: { requestId: "cancelled", phase: "ordinary", origins: [{ messageIndex: 0, toolCallId: "program-origin", origin: { toolName: "fixture", sources: [] }, start: 0, end: 2 }] } } as ObservedStreamOptions).result();
    expect(fetch).not.toHaveBeenCalled();
    expect(events.map(event => [event.state, event.responseState])).toEqual([["prepared", "not_sent"], ["failed", "not_sent"]]);
    expect(events[0]!.projections[0]!.text).toBe("材料");
  });

  it("propagates evidence observer failures and prevents transport", async () => {
    const input = snapshot(protocol);
    const gateway = new PiModelGateway();
    const model = gateway.createModel(input);
    const fetch = vi.fn(async () => new Response("must not send"));
    const failure = new Error("evidence storage failed");
    const stream = gateway.createStream(input, () => { throw failure; });
    await expect(stream(model, { messages: [{ role: "user", content: "材料", timestamp: 1 }] }, { apiKey: "fixture", fetch, requestObservation: { requestId: "storage-failure", phase: "ordinary", origins: [] } } as ObservedStreamOptions).result()).rejects.toBe(failure);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("marks changed adapter payload layouts unmapped without matching generated text", async () => {
    const input = snapshot(protocol);
    const gateway = new PiModelGateway();
    const model = gateway.createModel(input);
    const events: ModelRequestObservation[] = [];
    const stream = gateway.createStream(input, event => events.push(event));
    await stream(model, { messages: [{ role: "user", content: "材料", timestamp: 1 }] }, { apiKey: "fixture", fetch: async () => new Response("failure", { status: 503 }), onPayload: payload => ({ ...(payload as object), messages: [{ role: "user", content: "外部改写" }] }), requestObservation: { requestId: "changed", phase: "ordinary", origins: [{ messageIndex: 0, toolCallId: "program-origin", origin: { toolName: "fixture", sources: [] }, start: 0, end: 2 }] } } as ObservedStreamOptions).result();
    expect(events.filter(event => event.state === "dispatched")[0]!.projections[0]).toMatchObject({ mapping: "unmapped", text: "" });
  });
});

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
  it("probes the real Chat tool declarations in one short request without executing tools", async () => {
    const input = { ...snapshot("openai_compatible"), provider: "deepseek" as const };
    const requests = captureCompletionRequests(input.modelId, "tool_calls");
    const host = { request: vi.fn() };
    const tools = createPiChatInteractionTools({ requestId: "probe" } as never, host as never, { request: vi.fn() } as never);
    const service = new ConfigurationService({ resolveLlmDraft: async () => input } as never, new PiModelGateway());
    await expect(service.diagnoseLlm({} as never)).resolves.toMatchObject({ ok: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ max_tokens: 64, thinking: { type: "disabled" } });
    expect((requests[0]!.tools as any[]).map(t => t.function.name)).toEqual(["request_user_input", "interaction_draft", "propose_actions"]);
    const proposalSchema = (requests[0]!.tools as any[])[2].function.parameters;
    expect(proposalSchema.type).toBe("object");
    expect(proposalSchema).not.toHaveProperty("anyOf");
    const call = { capabilityId: "records", actionId: "add", contractDigest: `sha256:${"a".repeat(64)}`, input: { name: "甲" } };
    expect(Check(proposalSchema, { calls: [call] })).toBe(true);
    expect(Check(proposalSchema, { firstCall: call, endCondition: "加入记录", rules: [{ id: "add", call, maxExecutions: 1 }] })).toBe(true);
    expect((requests[0]!.tools as any[]).map(t => t.function)).toEqual(tools.map(t => ({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)), strict: false })));
    expect(host.request).not.toHaveBeenCalled();
  });
  it.each([
    [401, "secret-value", { reason: "auth" }],
    [400, "Invalid schema for function 'propose_actions': schema must be a JSON Schema of 'type: object', got 'type: None'. secret-value", { reason: "invalid_tool_schema", toolName: "propose_actions", rootObjectRequired: true }],
    [400, "secret-value arbitrary failure", { reason: "unknown" }],
    [400, "Invalid schema for function 'untrusted-secret-tool': missing properties", { reason: "invalid_tool_schema" }],
    [429, "secret-value", { reason: "rate_limit" }],
    [400, "maximum context length exceeded secret-value", { reason: "context" }],
  ])("returns only safe diagnostic fields for HTTP %s", async (status, body, detail) => {
    const fetch = vi.fn(async () => new Response(body as string, { status: status as number }));
    vi.stubGlobal("fetch", fetch);
    const service = new ConfigurationService({ resolveLlmDraft: async () => snapshot("openai_compatible") } as never, new PiModelGateway());
    const result = await service.diagnoseLlm({} as never);
    expect(result).toMatchObject({ ok: false, diagnostic: { httpStatus: status, ...detail } });
    expect(JSON.stringify(result)).not.toMatch(/secret-value|untrusted-secret-tool|missing properties/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
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
