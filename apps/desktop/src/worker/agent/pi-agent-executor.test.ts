import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { ToolBudgetSnapshot } from "@deepfield/tool-platform";
import { AgentWorkerEventSchema } from "@deepfield/contracts";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createPiAgentExecutor } from "./pi-agent-executor.js";
import type { PiExecutionRequest } from "./pi-execution-contract.js";
import { createPiChatAgent, type PiRuntime } from "./pi-chat-agent.js";
import {
  agentEnd,
  assistant,
  capture,
  FakePiAgent,
  makeRuntime,
  request,
  stubModel,
} from "./pi-chat-agent-test-helpers.js";

function executionRequest(webSearch = false): PiExecutionRequest {
  return {
    requestId: "req-1",
    prompt: "当前问题",
    systemPrompt: "sys",
    contextMessages: [
      { role: "user" as const, content: "历史用户", timestamp: 1 },
      { role: "assistant" as const, content: "历史助手", timestamp: 2 },
    ],
    llm: {
      id: "llm-1",
      name: "DeepSeek",
      provider: "deepseek" as const,
      protocol: "openai_compatible" as const,
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-flash",
      contextWindow: 128000,
      apiKey: "sk-secret-test-key",
    },
    ...(webSearch
      ? {
          search: {
            id: "search-1",
            name: "Search",
            provider: "zhipu" as const,
            baseUrl: "https://open.bigmodel.cn/api/paas/v4",
            options: { searchEngine: "search_std" },
            apiKey: "search-secret",
          },
        }
      : {}),
    toolAccess: webSearch
      ? { network: "enabled" as const, maxAgentTurns: 6, maxSearchCalls: 4, maxFetchCalls: 3 }
      : { network: "disabled" as const, maxAgentTurns: 6, maxSearchCalls: 0, maxFetchCalls: 0 },
  };
}

describe("Pi agent executor context boundary", () => {
  it("keeps mapped Chat history and checkpoints isolated across runs", async () => {
    const firstAnswer = assistant("第一个答案");
    const secondAnswer = assistant("第二个答案");
    const fakes = [
      new FakePiAgent({
        events: [{ type: "agent_start" }, { type: "message_end", message: firstAnswer }, agentEnd([firstAnswer])],
      }),
      new FakePiAgent({
        events: [{ type: "agent_start" }, { type: "message_end", message: secondAnswer }, agentEnd([secondAnswer])],
      }),
    ];
    let runIndex = 0;
    const sessionRuntime = makeRuntime(fakes[0]!, stubModel);
    const runtime: PiRuntime = {
      createSession: sessionRuntime.createSession,
      createAgent(options: AgentOptions) {
        const fake = fakes[runIndex++]!;
        fake.receivedOptions = options;
        return fake;
      },
    };
    const agent = createPiChatAgent(runtime);
    const firstRequest = request();
    firstRequest.context = {
      conversationId: "first-conversation",
      systemPrompt: "first system",
      messages: [{ role: "user", content: "first history", timestamp: 11, requestId: "first-history" }],
    };
    const secondRequest = request();
    secondRequest.requestId = "req-2";
    secondRequest.context = {
      conversationId: "second-conversation",
      systemPrompt: "second system",
      messages: [{ role: "user", content: "second history", timestamp: 22, requestId: "second-history" }],
    };

    const first = await capture(agent, undefined, firstRequest);
    const second = await capture(agent, undefined, secondRequest);

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(first.events.every((event) => Value.Check(AgentWorkerEventSchema, event))).toBe(true);
    expect(second.events.every((event) => Value.Check(AgentWorkerEventSchema, event))).toBe(true);
    expect(fakes[0]?.receivedOptions?.sessionId).toBe("first-conversation");
    expect(fakes[1]?.receivedOptions?.sessionId).toBe("second-conversation");
    expect(JSON.stringify(fakes[0]?.receivedOptions?.initialState?.messages)).toContain("first history");
    expect(JSON.stringify(fakes[0]?.receivedOptions?.initialState?.messages)).not.toContain("second history");
    expect(JSON.stringify(fakes[1]?.receivedOptions?.initialState?.messages)).toContain("second history");
    expect(JSON.stringify(fakes[1]?.receivedOptions?.initialState?.messages)).not.toContain("first history");
    const firstCheckpoints = first.events.filter((event) => event.type === "transcript_checkpoint");
    const secondCheckpoints = second.events.filter((event) => event.type === "transcript_checkpoint");
    expect(firstCheckpoints).toHaveLength(1);
    expect(secondCheckpoints).toHaveLength(1);
    expect(JSON.stringify(firstCheckpoints)).toContain("第一个答案");
    expect(JSON.stringify(firstCheckpoints)).not.toContain("第二个答案");
    expect(JSON.stringify(secondCheckpoints)).toContain("第二个答案");
    expect(JSON.stringify(secondCheckpoints)).not.toContain("第一个答案");
  });

  it("uses an injected context without a Chat adapter", async () => {
    const piRequest = executionRequest();
    const getApiKey = vi.fn(async () => "injected-api-key");
    const createSearchProvider = vi.fn();
    let resolvedApiKey: string | undefined;
    const answer = assistant("好的");
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        { type: "message_end", message: answer },
        agentEnd([answer]),
      ],
      beforeEvents: async (agent) => {
        resolvedApiKey = await agent.receivedOptions?.getApiKey?.("deepfield-provider");
      },
    });
    const injectedMessages = [{ role: "user" as const, content: "injected history", timestamp: 10 }];
    const ended: AgentMessage[] = [];
    const prepareContext = vi.fn((model) => {
      expect(model).toBe(stubModel);
      return {
        messages: injectedMessages,
        basePromptParts: ["context base prompt", ""],
        finalizationPromptParts: ["context finalization prompt"],
        sessionId: "injected-session",
        onMessageEnd: (message: AgentMessage) => ended.push(message),
      };
    });

    await createPiAgentExecutor(
      {
        runtime: makeRuntime(fake, stubModel),
        getApiKey,
        createSearchProvider,
      },
    ).run(piRequest, prepareContext, () => undefined, new AbortController().signal);

    expect(prepareContext).toHaveBeenCalledOnce();
    expect(getApiKey).toHaveBeenCalledWith(piRequest.llm, "deepfield-provider");
    expect(resolvedApiKey).toBe("injected-api-key");
    expect(createSearchProvider).not.toHaveBeenCalled();
    expect(fake.receivedOptions?.initialState?.messages).toEqual(injectedMessages);
    expect(fake.receivedOptions?.initialState?.systemPrompt).toContain("context base prompt\n");
    expect(fake.receivedOptions?.sessionId).toBe("injected-session");
    expect(ended).toEqual([answer]);
  });

  it("uses injected finalization prompt parts for Capability synthesis", async () => {
    const answer = assistant("最终答案");
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        { type: "message_end", message: answer },
        agentEnd([answer]),
      ],
    });
    const emptyBudget: ToolBudgetSnapshot = {
      total: { limit: 0, reserved: 0, consumed: 0, remaining: 0, exhausted: true },
      categories: {
        search: { limit: 0, reserved: 0, consumed: 0, remaining: 0, exhausted: true },
        fetch: { limit: 0, reserved: 0, consumed: 0, remaining: 0, exhausted: true },
        link_check: { reserved: 0, consumed: 0, exhausted: false },
        parse: { reserved: 0, consumed: 0, exhausted: false },
        none: { reserved: 0, consumed: 0, exhausted: false },
      },
    };
    const toolSessions = {
      createAgentTools: () => [],
      bindSearchProvider: vi.fn(),
      budgetSnapshot: () => emptyBudget,
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    const searchProvider = {
      id: "injected-search",
      capabilities: { timeRange: false },
      search: vi.fn(),
    };
    const createSearchProvider = vi.fn(() => searchProvider);
    const piRequest = executionRequest(true);
    piRequest.finalizationSystemPrompt = "structured output only";
    piRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns: 1,
      maxSearchCalls: 0,
      maxFetchCalls: 0,
    };

    await createPiAgentExecutor(
      {
        runtime: makeRuntime(fake, stubModel),
        getApiKey: async () => "injected-api-key",
        createSearchProvider,
      },
      {
        toolSessions,
        toolActor: "capability",
      },
    ).run(
      piRequest,
      () => ({
        messages: [],
        basePromptParts: ["context base prompt"],
        finalizationPromptParts: ["context finalization prompt"],
        sessionId: "capability-session",
      }),
      () => undefined,
      new AbortController().signal,
    );

    expect(createSearchProvider).toHaveBeenCalledWith(piRequest.search);
    expect(toolSessions.bindSearchProvider).toHaveBeenCalledWith(
      piRequest.requestId,
      searchProvider,
      {
        maxCalls: 8,
        categoryCalls: { search: 0, fetch: 0 },
      },
    );
    expect(fake.receivedOptions?.initialState?.systemPrompt).toContain("structured output only");
    expect(fake.receivedOptions?.initialState?.systemPrompt).toContain("context finalization prompt");
    expect(fake.receivedOptions?.initialState?.systemPrompt).not.toContain("context base prompt");
  });
});
