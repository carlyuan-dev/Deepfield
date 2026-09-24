import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";
import { FakeAuditSink, type ToolBudgetSnapshot } from "@deepfield/tool-platform";
import { MAIN_AGENT_SYSTEM_PROMPT } from "@deepfield/application";
import { SearchProviderError } from "@deepfield/retrieval";
import { createPiChatAgent, PiChatAgentError, type SkillCatalogProvider } from "./pi-chat-agent.js";
import { SkillNotFoundError, type PiSkillCatalog } from "../../shared/pi-skill-catalog.js";
import { createToolRuntime } from "../tools/tool-runtime.js";
import {
  agentEnd,
  assistant,
  assistantWithTool,
  capture,
  FakePiAgent,
  makeRuntime,
  makeInstalledPiRuntime,
  makeRecordingInstalledPiRuntime,
  request,
  stubModel,
  textDelta,
  thinkingDelta,
} from "./pi-chat-agent-test-helpers.js";

describe("pi chat agent", () => {
  const noOpToolSessions = {
    createAgentTools: () => [],
    bindSearchProvider: () => undefined,
    budgetSnapshot: () => budgetSnapshot(4, 3),
    recordSynthetic: async () => undefined,
    releaseTrace: () => true,
  };

  const budgetSnapshot = (search: number, fetch: number): ToolBudgetSnapshot => ({
    total: { limit: 7, reserved: 0, consumed: 7 - search - fetch, remaining: search + fetch, exhausted: search + fetch === 0 },
    categories: {
      search: { limit: 4, reserved: 0, consumed: 4 - search, remaining: search, exhausted: search === 0 },
      fetch: { limit: 3, reserved: 0, consumed: 3 - fetch, remaining: fetch, exhausted: fetch === 0 },
      link_check: { reserved: 0, consumed: 0, exhausted: false },
      parse: { reserved: 0, consumed: 0, exhausted: false },
      none: { reserved: 0, consumed: 0, exhausted: false },
    },
  });

  const budgetSnapshotFor = (
    searchLimit: number,
    fetchLimit: number,
    searchRemaining: number,
    fetchRemaining: number,
  ): ToolBudgetSnapshot => ({
    total: {
      limit: searchLimit + fetchLimit,
      reserved: 0,
      consumed: searchLimit + fetchLimit - searchRemaining - fetchRemaining,
      remaining: searchRemaining + fetchRemaining,
      exhausted: searchRemaining + fetchRemaining === 0,
    },
    categories: {
      search: {
        limit: searchLimit,
        reserved: 0,
        consumed: searchLimit - searchRemaining,
        remaining: searchRemaining,
        exhausted: searchRemaining === 0,
      },
      fetch: {
        limit: fetchLimit,
        reserved: 0,
        consumed: fetchLimit - fetchRemaining,
        remaining: fetchRemaining,
        exhausted: fetchRemaining === 0,
      },
      link_check: { reserved: 0, consumed: 0, exhausted: false },
      parse: { reserved: 0, consumed: 0, exhausted: false },
      none: { reserved: 0, consumed: 0, exhausted: false },
    },
  });

  const makeBudgetedNetworkTools = (
    searchLimit: number,
    fetchLimit: number,
    options: { searchFailure?: string } = {},
  ) => {
    let searchRemaining = searchLimit;
    let fetchRemaining = fetchLimit;
    const executions: string[] = [];
    return {
      executions,
      sessions: {
        createAgentTools: () => [
          {
            name: "web_search",
            description: "search",
            label: "search",
            parameters: Type.Object({ query: Type.String() }),
            async execute(toolCallId: string) {
              executions.push(toolCallId);
              searchRemaining -= 1;
              if (options.searchFailure !== undefined) {
                throw new Error(
                  `tool_failed ${JSON.stringify({
                    code: "timeout",
                    message: options.searchFailure,
                    retryable: false,
                    attempts: 1,
                    budgetConsumed: true,
                  })}`,
                );
              }
              return {
                content: [{
                  type: "text" as const,
                  text: searchRemaining === 0
                    ? '{"results":[]}'
                    : '{"results":[{"title":"evidence-title","url":"https://evidence.test/source","snippet":"evidence-snippet"}]}',
                }],
                details: {},
              };
            },
          },
          {
            name: "read_webpage",
            description: "fetch",
            label: "fetch",
            parameters: Type.Object({ url: Type.String() }),
            async execute(toolCallId: string, params: unknown) {
              executions.push(toolCallId);
              fetchRemaining -= 1;
              const url = typeof params === "object" && params !== null &&
                typeof (params as { url?: unknown }).url === "string"
                ? (params as { url: string }).url
                : "";
              return {
                content: [{
                  type: "text" as const,
                  text: JSON.stringify({ url, text: "fetched-evidence" }),
                }],
                details: {},
              };
            },
          },
        ],
        bindSearchProvider: () => undefined,
        budgetSnapshot: () => budgetSnapshotFor(
          searchLimit,
          fetchLimit,
          searchRemaining,
          fetchRemaining,
        ),
        recordSynthetic: async () => undefined,
        releaseTrace: () => true,
      },
    };
  };

  const messageText = (message: Message): string => {
    if (typeof message.content === "string") return message.content;
    return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
  };

  const expectPlainTextEvidence = (
    providerRequest: ReturnType<typeof makeRecordingInstalledPiRuntime>["requests"][number] | undefined,
    evidence: string,
  ) => {
    const evidenceMessages = providerRequest?.messages.filter((message) =>
      message.role !== "toolResult" && messageText(message).includes(evidence)
    ) ?? [];
    expect(evidenceMessages.length).toBeGreaterThan(0);
    expect(evidenceMessages.every((message) =>
      typeof message.content === "string" || message.content.every((part) => part.type === "text")
    )).toBe(true);
  };

  const expectToolFreeFinalizationRequest = (
    providerRequest: ReturnType<typeof makeRecordingInstalledPiRuntime>["requests"][number] | undefined,
  ) => {
    expect(providerRequest).toBeDefined();
    expect(providerRequest?.tools).toEqual([]);
    expect(providerRequest?.toolChoice).toBe("none");
    expect(providerRequest?.systemPrompt).not.toContain("本轮已开放联网工具");
    expect(providerRequest?.systemPrompt).not.toContain("web_search");
    expect(providerRequest?.systemPrompt).not.toContain("read_webpage");
    expect(providerRequest?.messages.some((message) => message.role === "toolResult")).toBe(false);
    expect(providerRequest?.messages.some((message) =>
      message.role === "assistant" && message.content.some((part) => part.type === "toolCall")
    )).toBe(false);
  };

  const expectIncrementallyStreamedAnswer = (
    events: AgentWorkerEvent[],
    finalText: string,
  ) => {
    const deltas = events.flatMap((event) => event.type === "text_delta" ? [event.delta] : []);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas).not.toContain(finalText);
    expect(deltas.join("")).toBe(finalText);
  };

  const expectImmediateFinalizationInstruction = (
    providerRequest: ReturnType<typeof makeRecordingInstalledPiRuntime>["requests"][number] | undefined,
  ) => {
    const instruction = providerRequest?.messages.at(-1);
    expect(instruction?.role).toBe("user");
    const instructionText = instruction === undefined ? "" : messageText(instruction);
    expect(instructionText).toContain(
      "工具阶段已结束。请立即基于本轮已获得的工具结果与文本证据，组织并输出最终答案。",
    );
  };

  it("streams an offline final answer as provider text deltas without duplicating it", async () => {
    const answer = assistant("你好");
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        textDelta("你"),
        textDelta("好"),
        { type: "message_end", message: answer },
        agentEnd([answer]),
      ],
    });

    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));

    expect(result.error).toBeUndefined();
    expect(result.events.filter((event) => event.type === "text_delta")).toEqual([
      { requestId: "req-1", type: "text_delta", delta: "你" },
      { requestId: "req-1", type: "text_delta", delta: "好" },
    ]);
    expect(result.events.at(-1)).toEqual({
      requestId: "req-1",
      type: "completed",
      text: "你好",
    });
  });

  it("keeps Capability tool-phase text private and streams only its explicit synthesis", async () => {
    const planning = assistantWithTool("正在搜索");
    const draft = assistant("工具阶段草稿");
    const final = assistant("最终答案");
    let followUps: unknown[] = [];
    const fake = new FakePiAgent({
      events: [],
      beforeEvents: async (agent) => {
        await agent.emit({ type: "agent_start" });
        await agent.emit(textDelta("正在搜索"));
        await agent.emit({ type: "message_end", message: planning });
        await agent.receivedOptions?.prepareNextTurnWithContext?.({
          message: planning,
          toolResults: [],
          context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [{ name: "web_search" }] },
          newMessages: [planning],
        } as never);
        await agent.emit(textDelta("工具阶段草稿"));
        await agent.emit({ type: "message_end", message: draft });
        await agent.receivedOptions?.prepareNextTurnWithContext?.({
          message: draft,
          toolResults: [],
          context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [{ name: "web_search" }] },
          newMessages: [planning, draft],
        } as never);
        followUps = agent.followUps;
        await agent.emit(textDelta("最终"));
        await agent.emit(textDelta("答案"));
        await agent.emit({ type: "message_end", message: final });
        await agent.emit(agentEnd([planning, draft, final]));
      },
    });
    const toolSessions = {
      createAgentTools: () => [],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(4, 3),
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    const events: AgentWorkerEvent[] = [];

    await createPiChatAgent(
      makeRuntime(fake, stubModel), [], undefined, {}, toolSessions,
      undefined, undefined, "capability",
    ).run(
      request({ webSearch: true }),
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(followUps).toHaveLength(1);
    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { requestId: "req-1", type: "text_delta", delta: "最终" },
      { requestId: "req-1", type: "text_delta", delta: "答案" },
    ]);
    expect(events.at(-1)).toEqual({ requestId: "req-1", type: "completed", text: "最终答案" });
    expect(JSON.stringify(events)).not.toContain("正在搜索");
    expect(JSON.stringify(events)).not.toContain("工具阶段草稿");
  });

  it("uses a clean tool-disabled Capability request after natural tool stopping", async () => {
    const searchCall = {
      type: "toolCall" as const,
      id: "natural-search",
      name: "web_search",
      arguments: { query: "recent evidence" },
    };
    const { sessions } = makeBudgetedNetworkTools(2, 1);
    const finalText = "这是基于现有证据形成的最终答案，包含结论、来源说明和仍待确认的事项，供用户直接阅读并继续判断。";
    const recording = makeRecordingInstalledPiRuntime([
      assistant("工具阶段正在搜索", {
        content: [
          { type: "text", text: "工具阶段正在搜索" },
          searchCall,
        ],
        stopReason: "toolUse",
      }),
      assistant("工具阶段已经自然停止"),
      assistant(finalText),
    ]);
    const webRequest = request({ webSearch: true });
    webRequest.prompt = "请研究目标公司的近期进展";
    webRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns: 6,
      maxSearchCalls: 2,
      maxFetchCalls: 1,
    };

    const result = await capture(
      createPiChatAgent(
        recording.runtime, [], undefined, {}, sessions,
        undefined, undefined, "capability",
      ),
      undefined,
      webRequest,
    );

    expect(result.error).toBeUndefined();
    expect(recording.requests).toHaveLength(3);
    const finalRequest = recording.requests.at(-1);
    expectPlainTextEvidence(finalRequest, "evidence-snippet");
    const finalizationText = finalRequest?.messages.map(messageText).join("\n") ?? "";
    expect(finalizationText).toContain("请研究目标公司的近期进展");
    expect(finalizationText).toContain("历史用户");
    expect(finalizationText).toContain("历史助手");
    expect(finalizationText).not.toContain("工具阶段正在搜索");
    expect(finalizationText).not.toContain("工具阶段已经自然停止");
    expectImmediateFinalizationInstruction(finalRequest);
    expectToolFreeFinalizationRequest(finalRequest);
    expectIncrementallyStreamedAnswer(result.events, finalText);
    expect(result.events.at(-1)).toEqual({
      requestId: "req-1",
      type: "completed",
      text: finalText,
    });
  });

  it.each([
    {
      limit: "agent turn",
      maxAgentTurns: 2,
      maxSearchCalls: 2,
      maxFetchCalls: 1,
      prompt: "研究目标公司",
      toolCall: {
        type: "toolCall" as const,
        id: "agent-turn-search",
        name: "web_search",
        arguments: { query: "target company" },
      },
    },
    {
      limit: "search",
      maxAgentTurns: 6,
      maxSearchCalls: 1,
      maxFetchCalls: 1,
      prompt: "研究目标公司",
      toolCall: {
        type: "toolCall" as const,
        id: "last-search",
        name: "web_search",
        arguments: { query: "target company" },
      },
    },
    {
      limit: "fetch",
      maxAgentTurns: 6,
      maxSearchCalls: 1,
      maxFetchCalls: 1,
      prompt: "研究 https://evidence.test/source",
      toolCall: {
        type: "toolCall" as const,
        id: "last-fetch",
        name: "read_webpage",
        arguments: { url: "https://evidence.test/source" },
      },
    },
  ])("enters Capability finalization immediately at the $limit limit", async ({
    maxAgentTurns,
    maxSearchCalls,
    maxFetchCalls,
    prompt,
    toolCall,
  }) => {
    const { sessions } = makeBudgetedNetworkTools(maxSearchCalls, maxFetchCalls);
    const finalText = "达到上限后形成的最终答案，包含现有结论、证据边界和仍待确认的事项，供用户直接阅读并继续判断。";
    const recording = makeRecordingInstalledPiRuntime([
      assistant("", { content: [toolCall], stopReason: "toolUse" }),
      assistant(finalText),
    ]);
    const webRequest = request({ webSearch: true });
    webRequest.prompt = prompt;
    webRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns,
      maxSearchCalls,
      maxFetchCalls,
    };

    const result = await capture(
      createPiChatAgent(
        recording.runtime, [], undefined, {}, sessions,
        undefined, undefined, "capability",
      ),
      undefined,
      webRequest,
    );

    expect(recording.requests).toHaveLength(2);
    const finalRequest = recording.requests.at(-1);
    expectImmediateFinalizationInstruction(finalRequest);
    expectToolFreeFinalizationRequest(finalRequest);
    expectIncrementallyStreamedAnswer(result.events, finalText);
    expect(result.error).toBeUndefined();
    expect(result.events.at(-1)).toEqual({
      requestId: "req-1",
      type: "completed",
      text: finalText,
    });
  });

  it("does not execute or continue after a Capability finalization response returns another tool intent", async () => {
    const firstCall = {
      type: "toolCall" as const,
      id: "limit-search",
      name: "web_search",
      arguments: { query: "target company" },
    };
    const forbiddenFinalCall = {
      type: "toolCall" as const,
      id: "forbidden-final-search",
      name: "web_search",
      arguments: { query: "one more search" },
    };
    const { sessions, executions } = makeBudgetedNetworkTools(1, 0);
    const recording = makeRecordingInstalledPiRuntime([
      assistant("", { content: [firstCall], stopReason: "toolUse" }),
      assistant("", { content: [forbiddenFinalCall], stopReason: "toolUse" }),
    ]);
    const webRequest = request({ webSearch: true });
    webRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns: 6,
      maxSearchCalls: 1,
      maxFetchCalls: 0,
    };

    const result = await capture(
      createPiChatAgent(
        recording.runtime, [], undefined, {}, sessions,
        undefined, undefined, "capability",
      ),
      undefined,
      webRequest,
    );

    expect(executions).toEqual(["limit-search"]);
    expect(recording.requests).toHaveLength(2);
    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect((result.error as PiChatAgentError).code).toBe("invalid_final_tool_use");
    expect(result.events.some((event) => event.type === "completed")).toBe(false);
  });

  it("converts a terminal Capability tool failure into ordinary finalization evidence", async () => {
    const failedCall = {
      type: "toolCall" as const,
      id: "terminal-failed-search",
      name: "web_search",
      arguments: { query: "target company" },
    };
    const { sessions, executions } = makeBudgetedNetworkTools(1, 1, {
      searchFailure: "terminal-search-failed",
    });
    const finalText = "工具失败后仍基于当前事实形成最终答案。";
    const recording = makeRecordingInstalledPiRuntime([
      assistant("", { content: [failedCall], stopReason: "toolUse" }),
      assistant(finalText),
    ]);
    const webRequest = request({ webSearch: true });
    webRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns: 6,
      maxSearchCalls: 1,
      maxFetchCalls: 1,
    };

    const result = await capture(
      createPiChatAgent(
        recording.runtime, [], undefined, {}, sessions,
        undefined, undefined, "capability",
      ),
      undefined,
      webRequest,
    );

    expect(recording.requests).toHaveLength(2);
    expect(executions).toEqual(["terminal-failed-search"]);
    expectPlainTextEvidence(recording.requests.at(-1), "terminal-search-failed");
    expectImmediateFinalizationInstruction(recording.requests.at(-1));
    expectToolFreeFinalizationRequest(recording.requests.at(-1));
    expect(result.error).toBeUndefined();
    expect(result.events.at(-1)).toEqual({ requestId: "req-1", type: "completed", text: finalText });
  });

  it("converts a terminal Capability budget trim into ordinary finalization evidence", async () => {
    const admittedCall = {
      type: "toolCall" as const,
      id: "admitted-search",
      name: "web_search",
      arguments: { query: "first query" },
    };
    const trimmedCall = {
      type: "toolCall" as const,
      id: "trimmed-search",
      name: "web_search",
      arguments: { query: "overflow query" },
    };
    const { sessions, executions } = makeBudgetedNetworkTools(1, 1);
    const finalText = "额度裁剪后基于当前事实形成最终答案。";
    const recording = makeRecordingInstalledPiRuntime([
      assistant("", { content: [admittedCall, trimmedCall], stopReason: "toolUse" }),
      assistant(finalText),
    ]);
    const webRequest = request({ webSearch: true });
    webRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns: 6,
      maxSearchCalls: 1,
      maxFetchCalls: 1,
    };

    const result = await capture(
      createPiChatAgent(
        recording.runtime, [], undefined, {}, sessions,
        undefined, undefined, "capability",
      ),
      undefined,
      webRequest,
    );

    expect(recording.requests).toHaveLength(2);
    expect(executions).toEqual(["admitted-search"]);
    expectPlainTextEvidence(recording.requests.at(-1), "budget_trimmed");
    expectImmediateFinalizationInstruction(recording.requests.at(-1));
    expectToolFreeFinalizationRequest(recording.requests.at(-1));
    expect(result.error).toBeUndefined();
    expect(result.events.at(-1)).toEqual({ requestId: "req-1", type: "completed", text: finalText });
  });

  it("resets streamed tool-turn narration before the final tool-free answer", async () => {
    const planning = assistantWithTool("I'll search recent sources.");
    const retrying = assistantWithTool("Some calls failed; retrying.", "read_webpage");
    const answerText = "近三个月，宇树科技公布了新的人形机器人进展。[来源](https://example.com)";
    const answer = assistant(answerText);
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        textDelta("I'll search recent sources."),
        { type: "message_end", message: planning },
        textDelta("Some calls failed; retrying."),
        { type: "message_end", message: retrying },
        textDelta("近三个月，宇树科技公布了新的人形机器人进展。"),
        { type: "message_end", message: answer },
        agentEnd([planning, retrying, answer]),
      ],
    });

    const result = await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, noOpToolSessions),
      undefined,
      request({ webSearch: true }),
    );

    expect(result.error).toBeUndefined();
    expect(result.events.filter((event) => event.type === "text_delta")).toEqual([
      { requestId: "req-1", type: "text_delta", delta: "I'll search recent sources." },
      { requestId: "req-1", type: "text_delta", delta: answerText },
    ]);
    expect(result.events.some((event) => event.type === "text_reset")).toBe(true);
    expect(result.events.at(-1)).toEqual({
      requestId: "req-1",
      type: "completed",
      text: answerText,
    });
    expect(JSON.stringify(result.events.filter(event => event.type !== "transcript_checkpoint"))).not.toContain("retrying");
  });

  it("fails instead of persisting narration when the run ends on a tool-using turn", async () => {
    const planning = assistantWithTool("I'll retry the failed calls.");
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        textDelta("I'll retry the failed calls."),
        { type: "message_end", message: planning },
        agentEnd([planning]),
      ],
    });

    const result = await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, noOpToolSessions),
      undefined,
      request({ webSearch: true }),
    );

    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect(result.events.some((event) => event.type === "completed")).toBe(false);
    expect(result.events.at(-1)).toEqual({ requestId: "req-1", type: "text_reset" });
  });

  it("reserves the last agent turn for tool-free synthesis", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
    const options = fake.receivedOptions;
    const toolTurn = assistantWithTool("继续搜索");
    const fiveAssistantTurns = Array.from({ length: 5 }, () => assistant("过程"));

    expect(options?.prepareNextTurnWithContext).toBeDefined();
    const update = await options?.prepareNextTurnWithContext?.({
      message: toolTurn,
      toolResults: [],
      context: {
        systemPrompt: "原始系统提示",
        model: stubModel,
        messages: [],
        tools: [{ name: "web_search" }],
      },
      newMessages: fiveAssistantTurns,
    } as never);

    expect(update?.context?.tools).toEqual([]);
    expect(update?.context?.systemPrompt).toContain("工具阶段已结束");
    expect(await options?.shouldStopAfterTurn?.({
      message: toolTurn,
      toolResults: [],
      context: update?.context,
      newMessages: fiveAssistantTurns,
    } as never)).toBe(false);
    expect(await options?.shouldStopAfterTurn?.({
      message: assistant("收尾"),
      toolResults: [],
      context: update?.context,
      newMessages: [...fiveAssistantTurns, assistant("收尾")],
    } as never)).toBe(true);
  });

  it("announces capability synthesis after the tool budget phase without exposing another tool", async () => {
    const planning = assistantWithTool("继续搜索");
    const final = assistant("最终报告");
    const fake = new FakePiAgent({
      events: [],
      beforeEvents: async (agent) => {
        await agent.emit({ type: "agent_start" });
        await agent.emit({ type: "message_end", message: planning });
        const update = await agent.receivedOptions?.prepareNextTurnWithContext?.({
          message: planning,
          toolResults: [],
          context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [{ name: "web_search" }] },
          newMessages: Array.from({ length: 5 }, () => assistant("过程")),
        } as never);
        expect(update?.context?.tools).toEqual([]);
        await agent.emit(textDelta("最终报告"));
        await agent.emit({ type: "message_end", message: final });
        await agent.emit(agentEnd([planning, final]));
      },
    });
    const result = await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, noOpToolSessions, undefined, undefined, "capability"),
      undefined,
      request({ webSearch: true }),
    );
    expect(result.events).toContainEqual(expect.objectContaining({
      type: "tool_activity", name: "research_synthesis", status: "running",
      summary: "资料检索完成，正在生成原始报告…",
    }));
    expect(result.events).toContainEqual(expect.objectContaining({ type: "tool_activity", name: "research_synthesis", status: "completed" }));
    expect(result.events.at(-1)).toMatchObject({ type: "completed", text: "最终报告" });
  });

  it("removes only exhausted search after a search budget rejection", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    const webSearch = { name: "web_search" } as never;
    const readWebpage = { name: "read_webpage" } as never;
    const toolSessions = {
      createAgentTools: () => [webSearch, readWebpage],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(0, 2),
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    const webRequest = request({ webSearch: true });
    webRequest.prompt = "核对 https://example.test/article";
    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      webRequest,
    );
    const update = await fake.receivedOptions?.prepareNextTurnWithContext?.({
      message: assistantWithTool("继续搜索"),
      toolResults: [{
        role: "toolResult",
        toolCallId: "call-web_search",
        toolName: "web_search",
        content: [{ type: "text", text: 'tool_failed {"code":"budget_exceeded","message":"budget exceeded","retryable":false,"attempts":1}' }],
        isError: true,
        timestamp: 1000,
      }],
      context: {
        systemPrompt: "原始系统提示",
        model: stubModel,
        messages: [],
        tools: [webSearch, readWebpage],
      },
      newMessages: [assistantWithTool("继续搜索")],
    } as never);

    expect(update?.context?.tools?.map((tool) => tool.name)).toEqual(["read_webpage"]);
    expect(update?.context?.systemPrompt).toContain("web_search: remaining 0 of 4");
    expect(update?.context?.systemPrompt).toContain("read_webpage: remaining 2 of 3");
  });

  it.each(["prompt", "history"] as const)(
    "preserves fetch after terminal search when a usable URL comes from %s",
    async (source) => {
      const fake = new FakePiAgent({
        events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
      });
      const toolSessions = {
        createAgentTools: () => [{ name: "web_search" } as never, { name: "read_webpage" } as never],
        bindSearchProvider: () => undefined,
        budgetSnapshot: () => budgetSnapshot(0, 2),
        recordSynthetic: async () => undefined,
        releaseTrace: () => true,
      };
      const webRequest = request({ webSearch: true });
      if (source === "prompt") webRequest.prompt = "打开 https://example.test/article";
      else webRequest.context.messages = [{ role: "user", content: "此前链接 https://example.test/article", timestamp: 1 }];

      await capture(
        createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
        undefined,
        webRequest,
      );

      expect(fake.receivedOptions?.initialState?.tools?.map((tool) => tool.name)).toEqual(["read_webpage"]);
    },
  );

  it("does not globally stop Chat when search is exhausted and no URL is known", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    const toolSessions = {
      createAgentTools: () => [{ name: "web_search" } as never, { name: "read_webpage" } as never],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(0, 2),
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };

    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      request({ webSearch: true }),
    );

    expect(fake.receivedOptions?.initialState?.tools?.map((tool) => tool.name)).toEqual(["read_webpage"]);
    expect(fake.receivedOptions?.initialState?.systemPrompt).toContain("phase: deciding");
  });

  it("keeps fetch available when the terminal search result supplies a usable URL", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    let snapshots = 0;
    const toolSessions = {
      createAgentTools: () => [{ name: "web_search" } as never, { name: "read_webpage" } as never],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => {
        snapshots += 1;
        return snapshots < 3 ? budgetSnapshot(1, 1) : budgetSnapshot(0, 1);
      },
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      request({ webSearch: true }),
    );
    const call = { type: "toolCall" as const, id: "terminal-search", name: "web_search", arguments: { query: "one" } };
    const batch = assistant("", { content: [call], stopReason: "toolUse" });
    await fake.receivedOptions?.beforeToolCall?.({ assistantMessage: batch, toolCall: call, args: call.arguments } as never);
    const update = await fake.receivedOptions?.prepareNextTurnWithContext?.({
      message: batch,
      toolResults: [{
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: '{"results":[{"url":"https://example.test/article"}]}' }],
        isError: false,
        timestamp: 1000,
      }],
      context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
      newMessages: [batch],
    } as never);

    expect(update?.context?.tools?.map((tool) => tool.name)).toEqual(["read_webpage"]);
    expect(update?.context?.systemPrompt).toContain("phase: deciding");
  });

  it("plans one assistant tool batch once and trims only overflow calls", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    let snapshots = 0;
    const synthetic: Array<{ status: string; toolCallId: string }> = [];
    const toolSessions = {
      createAgentTools: () => [{ name: "web_search" } as never],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => {
        snapshots += 1;
        return budgetSnapshot(4, 3);
      },
      recordSynthetic: async (record: { status: string; toolCallId: string }) => {
        synthetic.push(record);
      },
      releaseTrace: () => true,
    };
    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      request({ webSearch: true }),
    );
    const calls = Array.from({ length: 8 }, (_, index) => ({
      type: "toolCall" as const,
      id: `search-${index + 1}`,
      name: "web_search",
      arguments: { query: `query ${index + 1}` },
    }));
    const batch = assistant("", { content: calls, stopReason: "toolUse" });
    const results = [];
    for (const toolCall of calls) {
      results.push(await fake.receivedOptions?.beforeToolCall?.({
        assistantMessage: batch,
        toolCall,
        args: toolCall.arguments,
        context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
      } as never));
    }

    expect(snapshots).toBe(2); // initial context plus one whole-batch plan
    expect(results.filter((result) => result?.block)).toHaveLength(4);
    expect(synthetic).toEqual([
      expect.objectContaining({ status: "skipped", toolCallId: "search-5" }),
      expect.objectContaining({ status: "skipped", toolCallId: "search-6" }),
      expect.objectContaining({ status: "skipped", toolCallId: "search-7" }),
      expect.objectContaining({ status: "skipped", toolCallId: "search-8" }),
    ]);
  });

  it("returns an exact duplicate's successful payload through its own tool result without a second execution", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    let executions = 0;
    const synthetic: Array<{ status: string; toolCallId: string }> = [];
    const tool = {
      name: "web_search",
      description: "search",
      label: "search",
      parameters: {} as never,
      async execute(toolCallId: string) {
        executions += 1;
        return {
          content: [{ type: "text" as const, text: '{"results":[{"url":"https://a.test"}]}' }],
          details: { toolCallId },
        };
      },
    };
    const toolSessions = {
      createAgentTools: () => [tool],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(2, 2),
      recordSynthetic: async (record: { status: string; toolCallId: string }) => {
        synthetic.push(record);
      },
      releaseTrace: () => true,
    };
    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      request({ webSearch: true }),
    );
    const calls = [
      { type: "toolCall" as const, id: "search-a", name: "web_search", arguments: { query: " Unitree " } },
      { type: "toolCall" as const, id: "search-b", name: "web_search", arguments: { query: "unitree" } },
    ];
    const batch = assistant("", { content: calls, stopReason: "toolUse" });
    const wrappedTool = fake.receivedOptions?.initialState?.tools?.[0];
    const outputs = [];
    for (const call of calls) {
      const blocked = await fake.receivedOptions?.beforeToolCall?.({
        assistantMessage: batch,
        toolCall: call,
        args: call.arguments,
        context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
      } as never);
      expect(blocked?.block).not.toBe(true);
      outputs.push(await wrappedTool?.execute(call.id, call.arguments, undefined, undefined));
    }

    expect(executions).toBe(1);
    expect(outputs).toHaveLength(2);
    expect(outputs[1]?.content).toEqual(outputs[0]?.content);
    expect(outputs[1]?.details).toEqual({ toolCallId: "search-a", budgetConsumed: false });
    expect(synthetic).toEqual([
      expect.objectContaining({ status: "reused", toolCallId: "search-b" }),
    ]);
  });

  it("reuses a non-retryable failure with per-call budgetConsumed false", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    let executions = 0;
    const synthetic: Array<{ status: string; toolCallId: string; budgetConsumed: boolean }> = [];
    const toolSessions = {
      createAgentTools: () => [{
        name: "web_search",
        description: "search",
        label: "search",
        parameters: {} as never,
        async execute() {
          executions += 1;
          throw new Error('tool_failed {"code":"invalid_input","message":"invalid tool input","retryable":false,"attempts":1,"budgetConsumed":true}');
        },
      }],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(2, 2),
      recordSynthetic: async (record: { status: string; toolCallId: string; budgetConsumed: boolean }) => {
        synthetic.push(record);
      },
      releaseTrace: () => true,
    };
    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      request({ webSearch: true }),
    );
    const calls = ["failed-a", "failed-b"].map((id) => ({
      type: "toolCall" as const,
      id,
      name: "web_search",
      arguments: { query: "same" },
    }));
    const batch = assistant("", { content: calls, stopReason: "toolUse" });
    const wrapped = fake.receivedOptions?.initialState?.tools?.[0];
    const failures: string[] = [];
    for (const call of calls) {
      await fake.receivedOptions?.beforeToolCall?.({
        assistantMessage: batch,
        toolCall: call,
        args: call.arguments,
        context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
      } as never);
      try {
        await wrapped?.execute(call.id, call.arguments, undefined, undefined);
      } catch (error) {
        failures.push(String(error));
      }
    }

    expect(executions).toBe(1);
    expect(failures[0]).toContain('"budgetConsumed":true');
    expect(failures[1]).toContain('"budgetConsumed":false');
    expect(synthetic).toEqual([
      expect.objectContaining({ status: "reused", toolCallId: "failed-b", budgetConsumed: false }),
    ]);
  });

  it("promotes only the first valid sibling after an invalid duplicate source in the installed Pi loop", async () => {
    let providerCalls = 0;
    const provider = {
      id: "test",
      capabilities: { timeRange: false },
      async search() {
        providerCalls += 1;
        return {
          provider: "test",
          results: [{
            title: "result",
            url: "https://a.test/",
            snippet: "snippet",
            rank: 1,
            provider: "test",
          }],
        };
      },
    };
    const audit = new FakeAuditSink();
    const toolSessions = createToolRuntime({ audit });
    const toolTurn = assistant("", {
      content: [
        { type: "toolCall", id: "invalid-first", name: "web_search", arguments: { query: "same", maxResults: 0 } },
        { type: "toolCall", id: "valid-second", name: "web_search", arguments: { query: "same", maxResults: 3 } },
        { type: "toolCall", id: "valid-third", name: "web_search", arguments: { query: "same", maxResults: 3 } },
      ],
      stopReason: "toolUse",
    });
    let nextTurnSystemPrompt = "";

    const result = await capture(
      createPiChatAgent(
        makeInstalledPiRuntime([
          toolTurn,
          (context) => {
            nextTurnSystemPrompt = context.systemPrompt ?? "";
            return assistant("工具草稿");
          },
          assistant("最终答案"),
        ]),
        [],
        undefined,
        {},
        toolSessions,
        undefined,
        () => provider,
      ),
      undefined,
      request({ webSearch: true }),
    );

    expect(result.error).toBeUndefined();
    expect(providerCalls).toBe(1);
    expect(audit.records.filter((record) => record.kind === "finish")).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({ status: "completed", budgetConsumed: true }),
      }),
    ]);
    const synthetic = audit.records.filter((record) => record.kind === "synthetic");
    expect(synthetic).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({
          status: "failed",
          toolCallId: "invalid-first",
          errorCode: "invalid_input",
          budgetConsumed: false,
        }),
      }),
      expect.objectContaining({
        record: expect.objectContaining({
          status: "reused",
          toolCallId: "valid-third",
          budgetConsumed: false,
        }),
      }),
    ]);
    expect(synthetic[1]?.record).not.toHaveProperty("errorCode");
    expect(result.events.filter((event) => event.type === "tool_activity").map((event) => event.status)).toEqual([
      "running",
      "failed",
      "running",
      "completed",
      "running",
      "reused",
    ]);
    const invalidLive = result.events.find(
      (event) => event.type === "tool_activity" &&
        event.toolCallId === "invalid-first" &&
        event.status === "failed",
    );
    const invalidPersisted = audit.records.find(
      (record) => record.kind === "synthetic" && record.record.toolCallId === "invalid-first",
    );
    expect(invalidLive).toMatchObject({
      status: "failed",
      errorCode: "invalid_input",
      budgetConsumed: false,
      agentTurnIndex: 1,
      batchId: "batch-1",
    });
    expect(invalidPersisted?.record.executionId).toBe(
      invalidLive?.type === "tool_activity" ? invalidLive.callKey : undefined,
    );
    expect(result.events.find(
      (event) => event.type === "tool_activity" &&
        event.toolCallId === "valid-second" &&
        event.status === "completed",
    )).toMatchObject({ budgetConsumed: true, agentTurnIndex: 1, batchId: "batch-1" });
    expect(result.events.find(
      (event) => event.type === "tool_activity" &&
        event.toolCallId === "valid-second" &&
        event.status === "running",
    )).toMatchObject({ agentTurnIndex: 1, batchId: "batch-1" });
    expect(nextTurnSystemPrompt).toContain(
      'batch_summary: {"requested":3,"executed":1,"reused":1,"skipped":0',
    );
  });

  it("retries a provider timeout on a later model turn and binds its duplicate to the fresh success", async () => {
    let providerCalls = 0;
    const provider = {
      id: "test",
      capabilities: { timeRange: false },
      async search() {
        providerCalls += 1;
        if (providerCalls === 1) throw new SearchProviderError("timeout");
        return {
          provider: "test",
          results: [{
            title: "fresh result",
            url: "https://a.test/",
            snippet: "fresh snippet",
            rank: 1,
            provider: "test",
          }],
        };
      },
    };
    const first = assistant("", {
      content: [{ type: "toolCall", id: "timeout-first", name: "web_search", arguments: { query: "same", maxResults: 3 } }],
      stopReason: "toolUse",
    });
    const retry = assistant("", {
      content: [
        { type: "toolCall", id: "retry-source", name: "web_search", arguments: { query: "same", maxResults: 3 } },
        { type: "toolCall", id: "retry-duplicate", name: "web_search", arguments: { query: " same ", maxResults: 3 } },
      ],
      stopReason: "toolUse",
    });
    const audit = new FakeAuditSink();
    const result = await capture(
      createPiChatAgent(
        makeInstalledPiRuntime([first, retry, assistant("工具草稿"), assistant("最终答案")]),
        [],
        undefined,
        {},
        createToolRuntime({ audit }),
        undefined,
        () => provider,
      ),
      undefined,
      request({ webSearch: true }),
    );

    expect(result.error).toBeUndefined();
    expect(providerCalls).toBe(2);
    expect(audit.records.filter((record) => record.kind === "finish")).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({
          status: "failed",
          failure: expect.objectContaining({ code: "timeout", retryable: true }),
          budgetConsumed: true,
        }),
      }),
      expect.objectContaining({
        record: expect.objectContaining({ status: "completed", budgetConsumed: true }),
      }),
    ]);
    const reused = audit.records.filter((record) => record.kind === "synthetic");
    expect(reused).toEqual([
      expect.objectContaining({
        record: expect.objectContaining({
          status: "reused",
          toolCallId: "retry-duplicate",
          budgetConsumed: false,
        }),
      }),
    ]);
    expect(reused[0]?.record).not.toHaveProperty("errorCode");
    expect(result.events.find(
      (event) => event.type === "tool_activity" &&
        event.toolCallId === "timeout-first" &&
        event.status === "failed",
    )).toMatchObject({ errorCode: "timeout", budgetConsumed: true });
    expect(result.events.find(
      (event) => event.type === "tool_activity" &&
        event.toolCallId === "retry-duplicate" &&
        event.status === "reused",
    )).toMatchObject({ budgetConsumed: false });
  });

  it("dispatches a corrected date range after a pre-dispatch invalid range failure", async () => {
    let providerCalls = 0;
    const provider = {
      id: "test",
      capabilities: { timeRange: true },
      async search() {
        providerCalls += 1;
        return {
          provider: "test",
          results: [{
            title: "corrected result",
            url: "https://a.test/",
            snippet: "corrected snippet",
            rank: 1,
            provider: "test",
          }],
        };
      },
    };
    const reversed = assistant("", {
      content: [{
        type: "toolCall",
        id: "reversed-range",
        name: "web_search",
        arguments: {
          query: "same",
          maxResults: 3,
          timeRange: { from: "2026-09-14", to: "2026-06-14" },
        },
      }],
      stopReason: "toolUse",
    });
    const corrected = assistant("", {
      content: [{
        type: "toolCall",
        id: "corrected-range",
        name: "web_search",
        arguments: {
          query: "same",
          maxResults: 3,
          timeRange: { from: "2026-06-14", to: "2026-09-14" },
        },
      }],
      stopReason: "toolUse",
    });
    const audit = new FakeAuditSink();
    const result = await capture(
      createPiChatAgent(
        makeInstalledPiRuntime([reversed, corrected, assistant("工具草稿"), assistant("最终答案")]),
        [],
        undefined,
        {},
        createToolRuntime({ audit }),
        undefined,
        () => provider,
      ),
      undefined,
      request({ webSearch: true }),
    );

    expect(result.error).toBeUndefined();
    expect(providerCalls).toBe(1);
    expect(result.events.find(
      (event) => event.type === "tool_activity" &&
        event.toolCallId === "reversed-range" &&
        event.status === "failed",
    )).toMatchObject({ errorCode: "invalid_input", budgetConsumed: false });
    expect(result.events.find(
      (event) => event.type === "tool_activity" &&
        event.toolCallId === "corrected-range" &&
        event.status === "completed",
    )).toMatchObject({ budgetConsumed: true });
  });

  it("assigns utility-only and following search turns distinct scopes in the installed Pi loop", async () => {
    const observedScopes: Array<{ callId: string; turn: number | undefined }> = [];
    const toolSessions = {
      createAgentTools: (context: { batchScopeFor?: (toolCallId: string) => { agentTurnIndex: number } | undefined }) => [
        {
          name: "calculator",
          description: "calculate",
          label: "calculate",
          parameters: Type.Object({ value: Type.Number() }),
          async execute(toolCallId: string) {
            observedScopes.push({ callId: toolCallId, turn: context.batchScopeFor?.(toolCallId)?.agentTurnIndex });
            return { content: [{ type: "text" as const, text: "2" }], details: {} };
          },
        },
        {
          name: "web_search",
          description: "search",
          label: "search",
          parameters: Type.Object({ query: Type.String() }),
          async execute(toolCallId: string) {
            observedScopes.push({ callId: toolCallId, turn: context.batchScopeFor?.(toolCallId)?.agentTurnIndex });
            return { content: [{ type: "text" as const, text: '{"results":[{"url":"https://a.test"}]}' }], details: {} };
          },
        },
      ],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(2, 2),
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    const utilityTurn = assistant("", {
      content: [{ type: "toolCall", id: "utility-1", name: "calculator", arguments: { value: 1 } }],
      stopReason: "toolUse",
    });
    const searchTurn = assistant("", {
      content: [{ type: "toolCall", id: "search-2", name: "web_search", arguments: { query: "news" } }],
      stopReason: "toolUse",
    });

    const result = await capture(
      createPiChatAgent(
        makeInstalledPiRuntime([
          utilityTurn,
          searchTurn,
          assistant("工具草稿"),
          assistant("最终答案"),
        ]),
        [],
        undefined,
        {},
        toolSessions,
      ),
      undefined,
      request({ webSearch: true }),
    );

    expect(result.error).toBeUndefined();
    expect(observedScopes).toEqual([
      { callId: "utility-1", turn: 1 },
      { callId: "search-2", turn: 2 },
    ]);
  });

  it("does not globally stop Chat after two reuse-only network batches", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    const tool = {
      name: "web_search",
      description: "search",
      label: "search",
      parameters: {} as never,
      async execute() {
        return { content: [{ type: "text" as const, text: '{"results":[]}' }], details: {} };
      },
    };
    const toolSessions = {
      createAgentTools: () => [tool],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(3, 2),
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      request({ webSearch: true }),
    );
    const wrapped = fake.receivedOptions?.initialState?.tools?.[0];
    let finalUpdate:
      | { context?: { systemPrompt: string; tools?: Array<{ name: string }> } }
      | undefined;
    for (let turn = 1; turn <= 3; turn += 1) {
      const call = {
        type: "toolCall" as const,
        id: `same-${turn}`,
        name: "web_search",
        arguments: { query: "same query" },
      };
      const batch = assistant("", { content: [call], stopReason: "toolUse" });
      await fake.receivedOptions?.beforeToolCall?.({
        assistantMessage: batch,
        toolCall: call,
        args: call.arguments,
        context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
      } as never);
      const output = await wrapped?.execute(call.id, call.arguments, undefined, undefined);
      const toolResult = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: output?.content ?? [],
        isError: false,
        timestamp: 1000,
      };
      finalUpdate = await fake.receivedOptions?.prepareNextTurnWithContext?.({
        message: batch,
        toolResults: [toolResult],
        context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [wrapped] },
        newMessages: [batch, toolResult],
      } as never);
    }

    expect(finalUpdate?.context?.tools?.map((candidate) => candidate.name)).toEqual(["web_search"]);
    expect(finalUpdate?.context?.systemPrompt).toContain("phase: deciding");
  });

  it("announces synthesis when batch completion itself moves capability control to synthesis", async () => {
    const fake = new FakePiAgent({ events: [], pending: true });
    const tool = {
      name: "web_search", description: "search", label: "search", parameters: {} as never,
      async execute() { return { content: [{ type: "text" as const, text: '{"results":[]}' }], details: {} }; },
    };
    const toolSessions = {
      createAgentTools: () => [tool], bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(3, 2), recordSynthetic: async () => undefined, releaseTrace: () => true,
    };
    const controller = new AbortController();
    const resultPromise = capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions, undefined, undefined, "capability"),
      controller.signal,
      request({ webSearch: true }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const wrapped = fake.receivedOptions?.initialState?.tools?.[0];
    for (let turn = 1; turn <= 3; turn += 1) {
      const call = { type: "toolCall" as const, id: `auto-${turn}`, name: "web_search", arguments: { query: "same query" } };
      const batch = assistant("", { content: [call], stopReason: "toolUse" });
      await fake.receivedOptions?.beforeToolCall?.({ assistantMessage: batch, toolCall: call, args: call.arguments, context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] } } as never);
      const output = await wrapped?.execute(call.id, call.arguments, undefined, undefined);
      await fake.receivedOptions?.prepareNextTurnWithContext?.({
        message: batch,
        toolResults: [{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: output?.content ?? [], isError: false, timestamp: 1000 }],
        context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [wrapped] },
        newMessages: [batch],
      } as never);
    }
    controller.abort();
    const result = await resultPromise;
    expect(result.events.filter((event) => event.type === "tool_activity" && event.name === "research_synthesis" && event.status === "running")).toHaveLength(1);
  });

  it("keeps Chat running after two distinct successful empty search payloads", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    const toolSessions = {
      createAgentTools: () => [{ name: "web_search" } as never],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(3, 2),
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      request({ webSearch: true }),
    );
    let update: { context?: { systemPrompt: string; tools?: unknown[] } } | undefined;
    for (const [index, query] of ["empty one", "empty two"].entries()) {
      const call = {
        type: "toolCall" as const,
        id: `empty-${index}`,
        name: "web_search",
        arguments: { query },
      };
      const batch = assistant("", { content: [call], stopReason: "toolUse" });
      await fake.receivedOptions?.beforeToolCall?.({
        assistantMessage: batch,
        toolCall: call,
        args: call.arguments,
        context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
      } as never);
      update = await fake.receivedOptions?.prepareNextTurnWithContext?.({
        message: batch,
        toolResults: [{
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: '{"results":[]}' }],
          isError: false,
          timestamp: 1000,
        }],
        context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
        newMessages: [batch],
      } as never);
    }

    expect(update?.context?.tools).toHaveLength(1);
    expect(update?.context?.systemPrompt).toContain("phase: deciding");
  });

  it("closes search after authentication failure while preserving fetch", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    const webSearch = { name: "web_search" } as never;
    const readWebpage = { name: "read_webpage" } as never;
    const toolSessions = {
      createAgentTools: () => [webSearch, readWebpage],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(3, 2),
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    const webRequest = request({ webSearch: true });
    webRequest.prompt = "核对 https://example.test/article";
    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      webRequest,
    );

    const update = await fake.receivedOptions?.prepareNextTurnWithContext?.({
      message: assistantWithTool("继续搜索"),
      toolResults: [{
        role: "toolResult",
        toolCallId: "call-web_search",
        toolName: "web_search",
        content: [{ type: "text", text: 'tool_failed {"code":"authentication_failed","message":"authentication failed","retryable":false,"attempts":1}' }],
        isError: true,
        timestamp: 1000,
      }],
      context: { systemPrompt: "old", model: stubModel, messages: [], tools: [webSearch, readWebpage] },
      newMessages: [assistantWithTool("继续搜索")],
    } as never);

    expect(update?.context?.tools?.map((tool) => tool.name)).toEqual(["read_webpage"]);
    expect(update?.context?.systemPrompt).toContain("phase: deciding");
  });

  it("blocks later searches in the same batch after authentication fails but still admits fetch", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    let searchExecutions = 0;
    const searchTool = {
      name: "web_search",
      description: "search",
      label: "search",
      parameters: {} as never,
      async execute() {
        searchExecutions += 1;
        throw new Error('tool_failed {"code":"authentication_failed","message":"authentication failed","retryable":false,"attempts":1,"budgetConsumed":true}');
      },
    };
    const fetchTool = {
      name: "read_webpage",
      description: "fetch",
      label: "fetch",
      parameters: {} as never,
      async execute() {
        return {
          content: [{
            type: "text" as const,
            text: '{"url":"https://a.test/","text":"page","title":"a","truncated":false,"characterCount":4}',
          }],
          details: {},
        };
      },
    };
    const synthetic: Array<{ status: string; toolCallId: string }> = [];
    const toolSessions = {
      createAgentTools: () => [searchTool, fetchTool],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(4, 3),
      recordSynthetic: async (record: { status: string; toolCallId: string }) => {
        synthetic.push(record);
      },
      releaseTrace: () => true,
    };
    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      request({ webSearch: true }),
    );
    const calls = [
      { type: "toolCall" as const, id: "search-auth", name: "web_search", arguments: { query: "a" } },
      { type: "toolCall" as const, id: "search-after-auth", name: "web_search", arguments: { query: "b" } },
      { type: "toolCall" as const, id: "fetch-after-auth", name: "read_webpage", arguments: { url: "https://a.test" } },
    ];
    const batch = assistant("", { content: calls, stopReason: "toolUse" });
    const wrappedTools = fake.receivedOptions?.initialState?.tools ?? [];
    const first = await fake.receivedOptions?.beforeToolCall?.({
      assistantMessage: batch,
      toolCall: calls[0],
      args: calls[0]!.arguments,
      context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
    } as never);
    expect(first?.block).not.toBe(true);
    await expect(
      wrappedTools.find((tool) => tool.name === "web_search")?.execute(
        calls[0]!.id,
        calls[0]!.arguments,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/authentication_failed/);

    const second = await fake.receivedOptions?.beforeToolCall?.({
      assistantMessage: batch,
      toolCall: calls[1],
      args: calls[1]!.arguments,
      context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
    } as never);
    const fetch = await fake.receivedOptions?.beforeToolCall?.({
      assistantMessage: batch,
      toolCall: calls[2],
      args: calls[2]!.arguments,
      context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
    } as never);

    expect(second?.block).toBe(true);
    expect(fetch?.block).not.toBe(true);
    expect(searchExecutions).toBe(1);
    expect(synthetic).toEqual([
      expect.objectContaining({ status: "skipped", toolCallId: "search-after-auth" }),
    ]);
    const fetchOutput = await wrappedTools.find((tool) => tool.name === "read_webpage")?.execute(
      calls[2]!.id,
      calls[2]!.arguments,
      undefined,
      undefined,
    );
    const update = await fake.receivedOptions?.prepareNextTurnWithContext?.({
      message: batch,
      toolResults: [
        {
          role: "toolResult",
          toolCallId: calls[0]!.id,
          toolName: calls[0]!.name,
          content: [{ type: "text", text: 'tool_failed {"code":"authentication_failed"}' }],
          isError: true,
          timestamp: 1000,
        },
        {
          role: "toolResult",
          toolCallId: calls[1]!.id,
          toolName: calls[1]!.name,
          content: [{ type: "text", text: second?.reason ?? "" }],
          isError: true,
          timestamp: 1000,
        },
        {
          role: "toolResult",
          toolCallId: calls[2]!.id,
          toolName: calls[2]!.name,
          content: fetchOutput?.content ?? [],
          isError: false,
          timestamp: 1000,
        },
      ],
      context: { systemPrompt: "sys", model: stubModel, messages: [], tools: wrappedTools },
      newMessages: [batch],
    } as never);
    expect(update?.context?.systemPrompt).toContain(
      'batch_summary: {"requested":3,"executed":2,"reused":0,"skipped":1',
    );
  });

  it("emits a persisted skipped activity instead of presenting a trimmed call as a failure", async () => {
    const call = {
      type: "toolCall" as const,
      id: "search-trimmed",
      name: "web_search",
      arguments: { query: "overflow" },
    };
    const batch = assistant("", { content: [call], stopReason: "toolUse" });
    const answer = assistant("最终答案");
    const fake = new FakePiAgent({
      events: [],
      beforeEvents: async (agent) => {
        await agent.emit({ type: "agent_start" });
        await agent.emit({
          type: "tool_execution_start",
          toolCallId: call.id,
          toolName: call.name,
          args: call.arguments,
        });
        const blocked = await agent.receivedOptions?.beforeToolCall?.({
          assistantMessage: batch,
          toolCall: call,
          args: call.arguments,
          context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
        } as never);
        await agent.emit({
          type: "tool_execution_end",
          toolCallId: call.id,
          toolName: call.name,
          result: { content: [{ type: "text", text: blocked?.reason ?? "" }] },
          isError: true,
        });
        await agent.emit(agentEnd([answer]));
      },
    });
    const toolSessions = {
      createAgentTools: () => [{ name: "web_search" } as never],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(0, 2),
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };

    const result = await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      request({ webSearch: true }),
    );

    expect(result.error).toBeUndefined();
    expect(result.events.find((event) => event.type === "tool_activity" && event.status === "skipped")).toMatchObject({
      requestId: "req-1",
      type: "tool_activity",
      callKey: expect.stringMatching(/^tool-/),
      name: "web_search",
      status: "skipped",
      summary: "overflow",
      errorCode: "budget_trimmed",
      agentTurnIndex: 1,
      batchId: "batch-1",
      toolCallId: "search-trimmed",
      budgetConsumed: false,
    });
  });

  it("adds the completed batch summary only to next-turn runtime context", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("最终答案")])],
    });
    let snapshotCalls = 0;
    const toolSessions = {
      createAgentTools: () => [{ name: "web_search" } as never, { name: "read_webpage" } as never],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => {
        snapshotCalls += 1;
        return snapshotCalls < 3 ? budgetSnapshot(2, 2) : budgetSnapshot(1, 2);
      },
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions),
      undefined,
      request({ webSearch: true }),
    );
    const call = {
      type: "toolCall" as const,
      id: "search-one",
      name: "web_search",
      arguments: { query: "one" },
    };
    const batch = assistant("", { content: [call], stopReason: "toolUse" });
    await fake.receivedOptions?.beforeToolCall?.({
      assistantMessage: batch,
      toolCall: call,
      args: call.arguments,
      context: { systemPrompt: "old", model: stubModel, messages: [], tools: [] },
    } as never);
    const toolResult = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: '{"results":[]}' }],
      isError: false,
      timestamp: 1000,
    };
    const update = await fake.receivedOptions?.prepareNextTurnWithContext?.({
      message: batch,
      toolResults: [toolResult],
      context: { systemPrompt: "old", model: stubModel, messages: [], tools: [] },
      newMessages: [batch, toolResult],
    } as never);

    expect(update?.context?.systemPrompt).toContain(
      'batch_summary: {"requested":1,"executed":1,"reused":0,"skipped":0',
    );
    expect(update?.context?.systemPrompt).toContain('"web_search":1,"read_webpage":2');
    expect(update?.context?.messages).toEqual([]);
  });

  it.each([
    ["空白答案", "   "],
    ["DSML 工具协议", '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="web_search"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>'],
    ["与中文问题不一致的纯英文答案", "I could not verify the requested information."],
  ])("rejects a final turn containing only %s", async (_label, finalText) => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant(finalText)])],
    });

    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));

    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect(result.events.some((event) => event.type === "completed")).toBe(false);
  });

  it("adds non-persisted offline and local-date context to each Pi session", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("好的")])],
    });
    const agent = createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {
      clock: () => new Date("2026-09-08T16:30:00.000Z"),
      timeZone: "Asia/Shanghai",
    });
    const workerRequest = request({ webSearch: false });
    workerRequest.context.systemPrompt = MAIN_AGENT_SYSTEM_PROMPT;

    await agent.run(workerRequest, () => undefined, new AbortController().signal);

    const systemPrompt = fake.receivedOptions?.initialState?.systemPrompt;
    expect(systemPrompt).toContain(MAIN_AGENT_SYSTEM_PROMPT);
    expect(systemPrompt).toContain("当前日期：2026-09-09");
    expect(systemPrompt).toContain("本机时区：Asia/Shanghai");
    expect(systemPrompt).toContain("本轮未启用联网搜索");
    expect(systemPrompt).toContain("不允许发起新的网页搜索或抓取");
    expect(systemPrompt).toContain("可以直接使用上下文已有的网页内容及来源链接");
    expect(systemPrompt).not.toContain("不能处理本地文件");
    expect(workerRequest.context.systemPrompt).toBe(MAIN_AGENT_SYSTEM_PROMPT);
    expect(fake.promptedWith).toBe("当前问题");
  });

  it("keeps the restrained Markdown policy in main-agent normal, retry, and synthesis prompts", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("好的")])],
    });

    await createPiChatAgent(makeRuntime(fake, stubModel)).run(
      request({ webSearch: false }),
      () => undefined,
      new AbortController().signal,
    );

    const systemPrompt = fake.receivedOptions?.initialState?.systemPrompt ?? "";
    expect(systemPrompt).toContain("使用与用户相同的语言回答");
    expect(systemPrompt).toContain("优先使用简洁段落和必要的列表");
    expect(systemPrompt).toContain("避免不必要的一级标题、重复的水平分隔线、装饰性 emoji 和过度加粗");
    expect(systemPrompt).toContain("仅在能提升可读性时使用 Markdown");
    expect(systemPrompt).toContain("可以使用有助于表达的表格、链接和代码");

    const options = fake.receivedOptions;
    const toolTurn = assistantWithTool("继续搜索");
    const retryUpdate = await options?.prepareNextTurnWithContext?.({
      message: toolTurn,
      toolResults: [],
      context: { systemPrompt: "原始系统提示", model: stubModel, messages: [], tools: [] },
      newMessages: [toolTurn],
    } as never);
    expect(retryUpdate?.context?.systemPrompt).toContain("优先使用简洁段落和必要的列表");

    const fiveAssistantTurns = Array.from({ length: 5 }, () => assistant("过程"));
    const synthesisUpdate = await options?.prepareNextTurnWithContext?.({
      message: toolTurn,
      toolResults: [],
      context: { systemPrompt: "原始系统提示", model: stubModel, messages: [], tools: [] },
      newMessages: fiveAssistantTurns,
    } as never);
    expect(synthesisUpdate?.context?.systemPrompt).toContain("优先使用简洁段落和必要的列表");
    expect(synthesisUpdate?.context?.systemPrompt).toContain("工具阶段已结束");
  });

  it("adds online tool guidance and marks started events for web-enabled runs", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("好的")])],
    });
    const toolSessions = {
      createAgentTools: () => [],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => budgetSnapshot(4, 3),
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    const events: AgentWorkerEvent[] = [];
    await createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, toolSessions).run(
      request({ webSearch: true }),
      (event) => events.push(event),
      new AbortController().signal,
    );

    const systemPrompt = fake.receivedOptions?.initialState?.systemPrompt;
    expect(systemPrompt).not.toContain("本轮未启用联网搜索");
    expect(systemPrompt).toContain("web_search");
    expect(systemPrompt).toContain("read_webpage");
    expect(events[0]).toEqual({ requestId: "req-1", type: "started", webSearch: true });
  });

  it("maps real tool start/end events to ordered safe chat activity events", async () => {
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        textDelta("你"),
        thinkingDelta(),
        textDelta("好"),
        { type: "agent_start" },
        {
          type: "tool_execution_start",
          toolCallId: "provider-secret-id",
          toolName: "fetch_url",
          args: { url: "https://example.com/private?q=secret", apiKey: "sk-never-render" },
        },
        {
          type: "tool_execution_update",
          toolCallId: "provider-secret-id",
          toolName: "fetch_url",
          args: { url: "https://example.com/private?q=secret" },
          partialResult: { body: "never render this body" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "provider-secret-id",
          toolName: "fetch_url",
          result: { content: [{ type: "text", text: "full private page body" }] },
          isError: false,
        },
        { type: "message_end", message: assistant("你好") },
        agentEnd([assistant("你好")]),
      ],
    });
    const result = await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, noOpToolSessions),
      undefined,
      request({ webSearch: true }),
    );
    expect(result.error).toBeUndefined();
    expect(result.events.filter((event) => event.type === "started")).toHaveLength(1);
    expect(result.events.filter(event => event.type !== "transcript_checkpoint")).toEqual([
      { requestId: "req-1", type: "started", webSearch: true },
      { requestId: "req-1", type: "text_delta", delta: "你" },
      { requestId: "req-1", type: "text_delta", delta: "好" },
      {
        requestId: "req-1",
        type: "tool_activity",
        callKey: expect.stringMatching(/^tool-/),
        name: "fetch_url",
        status: "running",
        summary: "example.com",
        queryOrUrl: "https://example.com/private?q=secret",
        toolCallId: "provider-secret-id",
      },
      {
        requestId: "req-1",
        type: "tool_activity",
        callKey: expect.stringMatching(/^tool-/),
        name: "fetch_url",
        status: "completed",
        summary: "example.com",
        queryOrUrl: "https://example.com/private?q=secret",
        toolCallId: "provider-secret-id",
        durationMs: expect.any(Number),
      },
      { requestId: "req-1", type: "completed", text: "你好" },
    ]);
    const serialized = JSON.stringify(result.events);
    expect(serialized).toContain("provider-secret-id");
    expect(serialized).not.toContain("sk-never-render");
    expect(serialized).toContain("https://example.com/private?q=secret");
    expect(serialized).not.toContain("full private page body");
    expect(serialized).not.toContain("never render this body");
    expect(serialized).not.toContain("sk-secret-test-key");
  });

  it("marks an in-flight tool failed with no raw exception when the run rejects", async () => {
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        {
          type: "tool_execution_start",
          toolCallId: "internal-t2",
          toolName: "read_conversation",
          args: { conversationId: "internal-c1", limit: 20 },
        },
      ],
      reject: new Error("raw stack and sk-secret-test-key"),
    });

    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));

    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect(result.events.at(-1)).toEqual({
      requestId: "req-1",
      type: "tool_activity",
      callKey: expect.stringMatching(/^tool-/),
      name: "read_conversation",
      status: "failed",
      summary: "指定对话",
      toolCallId: "internal-t2",
    });
    expect(JSON.stringify(result.events)).not.toContain("internal-c1");
  });

  it("throws a sanitized error when agent_end carries an error assistant message", async () => {
    const fake = new FakePiAgent({
      events: [
        agentEnd([
          assistant("", { stopReason: "error", errorMessage: "provider exploded sk-secret-test-key" }),
        ]),
      ],
    });
    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect((result.error as PiChatAgentError).code).toBe("provider_failed");
    expect(result.events.some((event) => event.type === "completed")).toBe(false);
    expect(result.error?.message).not.toContain("provider exploded");
    expect(result.error?.message).not.toContain("sk-secret-test-key");
    expect(result.error?.message).not.toContain("当前问题");
  });

  it("emits one bounded diagnostic classification without provider error text", async () => {
    const diagnostics: unknown[] = [];
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("", { stopReason: "error", errorMessage: "provider secret sk-test" })])],
    });
    const result = await capture(createPiChatAgent(
      makeRuntime(fake, stubModel), [], undefined, {}, undefined, undefined, undefined, "capability",
      (diagnostic) => diagnostics.push(diagnostic),
    ));
    expect((result.error as PiChatAgentError).code).toBe("provider_failed");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      traceId: "req-1", phase: "deciding", errorCategory: "provider_failed",
      stopReason: "error", maxModelInputCharsEstimate: expect.any(Number), outputChars: 0,
    });
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain("provider secret");
    expect(serialized).not.toContain("sk-test");
    expect(serialized).not.toContain("当前问题");
  });

  it("throws for aborted or errorMessage assistant outcomes", async () => {
    const cases: Array<Partial<AssistantMessage>> = [
      { stopReason: "aborted" },
      { stopReason: "stop", errorMessage: "boom" },
    ];
    for (const overrides of cases) {
      const fake = new FakePiAgent({ events: [agentEnd([assistant("", overrides)])] });
      const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
      expect(result.error).toBeInstanceOf(PiChatAgentError);
      expect((result.error as PiChatAgentError).code).toBe("provider_failed");
      expect(result.events.some((event) => event.type === "completed")).toBe(false);
    }
  });

  it("throws a sanitized error when prompt rejects", async () => {
    const fake = new FakePiAgent({
      events: [],
      reject: new Error("provider auth failed for sk-secret-test-key"),
    });
    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect((result.error as PiChatAgentError).code).toBe("provider_failed");
    expect(result.error?.message).not.toContain("provider auth failed");
    expect(result.error?.message).not.toContain("sk-secret-test-key");
  });

  it("preserves observed turn, stop, output, and expanded context when a later prompt rejects", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const planning = assistantWithTool("先检索资料");
    const largeToolResult = "检索正文".repeat(5000);
    const fake = new FakePiAgent({
      events: [],
      beforeEvents: async (agent) => {
        await agent.emit({ type: "agent_start" });
        await agent.emit({ type: "message_end", message: planning });
        await agent.receivedOptions?.prepareNextTurnWithContext?.({
          message: planning,
          toolResults: [{
            role: "toolResult", toolCallId: "call-web_search", toolName: "web_search",
            content: [{ type: "text", text: largeToolResult }], isError: false, timestamp: 1000,
          }],
          context: { systemPrompt: "sys", model: stubModel, messages: [], tools: [] },
          newMessages: [planning],
        } as never);
      },
      reject: new Error("provider rejected with secret sk-never-store"),
    });
    const result = await capture(createPiChatAgent(
      makeRuntime(fake, stubModel), [], undefined, {}, noOpToolSessions, undefined, undefined,
      "capability", (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
    ), undefined, request({ webSearch: true }));

    expect((result.error as PiChatAgentError).code).toBe("provider_failed");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      agentTurns: 1,
      stopReason: "tool_use",
      outputChars: "先检索资料".length,
      errorCategory: "provider_failed",
    });
    expect(diagnostics[0]?.maxModelInputCharsEstimate).toEqual(expect.any(Number));
    expect(diagnostics[0]?.maxModelInputCharsEstimate as number).toBeGreaterThan(largeToolResult.length);
    expect(JSON.stringify(diagnostics)).not.toContain("sk-never-store");
  });

  it("records an aborted stop without a provider failure category", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const fake = new FakePiAgent({ events: [], pending: true });
    const promise = capture(createPiChatAgent(
      makeRuntime(fake, stubModel), [], undefined, {}, undefined, undefined, undefined,
      "capability", (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
    ), controller.signal);
    await vi.waitFor(() => expect(fake.promptCallCount).toBe(1));
    controller.abort();
    await promise;

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ stopReason: "aborted" });
    expect(diagnostics[0]).not.toHaveProperty("errorCategory");
  });

  it("records a diagnostic when runtime session creation throws", async () => {
    const diagnostics: Array<Record<string, unknown>> = [];
    const runtime = {
      createSession() { throw new Error("secret provider configuration"); },
      createAgent() { throw new Error("unreachable"); },
    };
    const result = await capture(createPiChatAgent(
      runtime as never, [], undefined, {}, undefined, undefined, undefined,
      "capability", (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
    ));

    expect((result.error as PiChatAgentError).code).toBe("provider_failed");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ stopReason: "unknown", errorCategory: "provider_failed" });
    expect(JSON.stringify(diagnostics)).not.toContain("secret provider configuration");
  });

  it("throws a sanitized error when prompt resolves without agent_end", async () => {
    const fake = new FakePiAgent({ events: [{ type: "agent_start" }, textDelta("hi")] });
    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect((result.error as PiChatAgentError).code).toBe("incomplete_lifecycle");
    expect(result.events.some((event) => event.type === "completed")).toBe(false);
  });

  it.each([
    ["", "invalid_final_empty"],
    ["<｜｜DSML｜｜ calls>private</｜｜DSML｜｜ calls>", "invalid_final_protocol"],
  ] as const)("classifies invalid final output as %s -> %s", async (text, code) => {
    const answer = assistant(text);
    const fake = new FakePiAgent({ events: [{ type: "agent_start" }, agentEnd([answer])] });
    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect((result.error as PiChatAgentError).code).toBe(code);
  });

  it("classifies a terminal assistant tool call separately from an empty answer", async () => {
    const planning = assistantWithTool("");
    const fake = new FakePiAgent({ events: [{ type: "agent_start" }, agentEnd([planning])] });
    const result = await capture(
      createPiChatAgent(makeRuntime(fake, stubModel), [], undefined, {}, noOpToolSessions),
      undefined,
      request({ webSearch: true }),
    );
    expect((result.error as PiChatAgentError).code).toBe("invalid_final_tool_use");
  });

  it("does not abort on a normal completion and cleans up listeners", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("好的")])],
    });
    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
    expect(result.error).toBeUndefined();
    expect(fake.aborted).toBe(false);
    expect(fake.listenerCount).toBe(0);
  });

  it("treats agent_end without agent_start as a protocol failure", async () => {
    const fake = new FakePiAgent({ events: [agentEnd([assistant("ok")])] });
    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect(result.events.some((event) => event.type === "started")).toBe(false);
    expect(result.events.some((event) => event.type === "completed")).toBe(false);
    expect(result.error?.message).not.toContain("sk-secret-test-key");
  });
});

describe("pi chat agent skill invocation", () => {
  const catalog: PiSkillCatalog = {
    list: () => [],
    formatInvocation: (name, instructions) => `[skill:${name}]\n${instructions}`,
  };
  const provider: SkillCatalogProvider = { get: async () => catalog };
  const skillEvents = [
    { type: "agent_start" as const },
    textDelta("你"),
    agentEnd([assistant("好的")]),
  ];

  it("formats the prompt through the injected catalog and reports the skill on started", async () => {
    const fake = new FakePiAgent({ events: skillEvents });
    const agent = createPiChatAgent(makeRuntime(fake, stubModel), [], provider);
    const events: AgentWorkerEvent[] = [];
    await agent.run(
      request({ webSearch: false, skillName: "structured-brief" }),
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(fake.promptedWith).toBe("[skill:structured-brief]\n当前问题");
    expect(events[0]).toEqual({
      requestId: "req-1",
      type: "started",
      skillName: "structured-brief",
    });
    expect(events.some((event) => event.type === "completed")).toBe(true);
  });

  it("keeps the original prompt when no skill is selected, even with a provider present", async () => {
    const fake = new FakePiAgent({ events: skillEvents });
    const agent = createPiChatAgent(makeRuntime(fake, stubModel), [], provider);
    const events: AgentWorkerEvent[] = [];
    await agent.run(request(), (event) => events.push(event), new AbortController().signal);
    expect(fake.promptedWith).toBe("当前问题");
    expect(events[0]).toEqual({ requestId: "req-1", type: "started" });
  });

  it("maps an unknown skill to a fixed non-sensitive failure", async () => {
    const unknownCatalog: PiSkillCatalog = {
      list: () => [],
      formatInvocation: () => {
        throw new SkillNotFoundError("structured-brief");
      },
    };
    const unknownProvider: SkillCatalogProvider = { get: async () => unknownCatalog };
    const fake = new FakePiAgent({ events: skillEvents });
    const agent = createPiChatAgent(makeRuntime(fake, stubModel), [], unknownProvider);
    const events: AgentWorkerEvent[] = [];
    let caught: unknown;
    try {
      await agent.run(
        request({ webSearch: false, skillName: "structured-brief" }),
        (event) => events.push(event),
        new AbortController().signal,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PiChatAgentError);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toBe("agent execution failed");
    expect(message).not.toContain("structured-brief");
    expect(message).not.toContain("当前问题");
    expect(fake.promptCallCount).toBe(0);
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });
});

const hasSmokeKey =
  typeof process.env.DEEPSEEK_API_KEY === "string" && process.env.DEEPSEEK_API_KEY.length > 0;

it.skipIf(!hasSmokeKey)(
  "smoke: real DeepSeek completion without tools",
  async () => {
    const agent = createPiChatAgent();
    const events: AgentWorkerEvent[] = [];
    const controller = new AbortController();
    const smokeRequest: AgentWorkerRequest = {
      ...request({ webSearch: false }),
      requestId: "smoke-1",
      prompt: "只回复 OK",
      context: {
        conversationId: "c1",
        systemPrompt: "你是 Deepfield 的主 Agent",
        messages: [],
      },
      llm: { ...request().llm, apiKey: process.env.DEEPSEEK_API_KEY ?? "" },
    };
    await agent.run(smokeRequest, (event) => events.push(event), controller.signal);
    const completed = events.find((event) => event.type === "completed");
    expect(completed).toBeDefined();
    if (completed?.type === "completed") {
      expect(completed.text.length).toBeGreaterThan(0);
    }
  },
  60000,
);
