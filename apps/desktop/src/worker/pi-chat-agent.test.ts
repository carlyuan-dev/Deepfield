import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";
import { MAIN_AGENT_SYSTEM_PROMPT } from "@deepfield/application";
import { createPiChatAgent, PiChatAgentError, type SkillCatalogProvider } from "./pi-chat-agent.js";
import { SkillNotFoundError, type PiSkillCatalog } from "../shared/pi-skill-catalog.js";
import {
  agentEnd,
  assistant,
  assistantWithTool,
  capture,
  FakePiAgent,
  makeRuntime,
  request,
  stubModel,
  textDelta,
  thinkingDelta,
} from "./pi-chat-agent-test-helpers.js";

describe("pi chat agent", () => {
  it("keeps tool-turn narration private and emits only the final tool-free answer", async () => {
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

    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));

    expect(result.error).toBeUndefined();
    expect(result.events.filter((event) => event.type === "text_delta")).toEqual([
      { requestId: "req-1", type: "text_delta", delta: answerText },
    ]);
    expect(result.events.at(-1)).toEqual({
      requestId: "req-1",
      type: "completed",
      text: answerText,
    });
    expect(JSON.stringify(result.events)).not.toContain("I'll search");
    expect(JSON.stringify(result.events)).not.toContain("retrying");
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

    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));

    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect(result.events.some((event) => event.type === "completed")).toBe(false);
    expect(JSON.stringify(result.events)).not.toContain("I'll retry");
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
    expect(systemPrompt).toContain("不能访问用户提供的网页");
    expect(systemPrompt).toContain("打开输入区的“联网搜索”");
    expect(systemPrompt).not.toContain("不能处理本地文件");
    expect(workerRequest.context.systemPrompt).toBe(MAIN_AGENT_SYSTEM_PROMPT);
    expect(fake.promptedWith).toBe("当前问题");
  });

  it("adds online tool guidance and marks started events for web-enabled runs", async () => {
    const fake = new FakePiAgent({
      events: [{ type: "agent_start" }, agentEnd([assistant("好的")])],
    });
    const toolSessions = {
      createAgentTools: () => [],
      bindSearchProvider: () => undefined,
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
    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
    expect(result.error).toBeUndefined();
    expect(result.events.filter((event) => event.type === "started")).toHaveLength(1);
    expect(result.events).toEqual([
      { requestId: "req-1", type: "started" },
      {
        requestId: "req-1",
        type: "tool_activity",
        callKey: "activity-1",
        name: "fetch_url",
        status: "running",
        summary: "example.com",
      },
      {
        requestId: "req-1",
        type: "tool_activity",
        callKey: "activity-1",
        name: "fetch_url",
        status: "completed",
        summary: "example.com",
      },
      { requestId: "req-1", type: "text_delta", delta: "你好" },
      { requestId: "req-1", type: "completed", text: "你好" },
    ]);
    const serialized = JSON.stringify(result.events);
    expect(serialized).not.toContain("provider-secret-id");
    expect(serialized).not.toContain("sk-never-render");
    expect(serialized).not.toContain("private");
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
      callKey: "activity-1",
      name: "read_conversation",
      status: "failed",
      summary: "指定对话",
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
    expect(result.events.some((event) => event.type === "completed")).toBe(false);
    expect(result.error?.message).not.toContain("provider exploded");
    expect(result.error?.message).not.toContain("sk-secret-test-key");
    expect(result.error?.message).not.toContain("当前问题");
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
    expect(result.error?.message).not.toContain("provider auth failed");
    expect(result.error?.message).not.toContain("sk-secret-test-key");
  });

  it("throws a sanitized error when prompt resolves without agent_end", async () => {
    const fake = new FakePiAgent({ events: [{ type: "agent_start" }, textDelta("hi")] });
    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect(result.events.some((event) => event.type === "completed")).toBe(false);
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
