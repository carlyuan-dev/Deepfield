import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";
import { DEFAULT_DEEPSEEK_MODEL_ID } from "@deepfield/contracts";
import { createPiChatAgent, PiChatAgentError, type SkillCatalogProvider } from "./pi-chat-agent.js";
import { SkillNotFoundError, type PiSkillCatalog } from "../shared/pi-skill-catalog.js";
import {
  agentEnd,
  assistant,
  capture,
  FakePiAgent,
  makeRuntime,
  request,
  stubModel,
  textDelta,
  thinkingDelta,
} from "./pi-chat-agent-test-helpers.js";

describe("pi chat agent", () => {
  it("emits exactly one started, ordered deltas and one completed", async () => {
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        textDelta("你"),
        thinkingDelta(),
        textDelta("好"),
        { type: "agent_start" },
        { type: "tool_execution_start", toolCallId: "t1", toolName: "x", args: {} },
        { type: "message_end", message: assistant("你好") },
        agentEnd([assistant("你好")]),
      ],
    });
    const result = await capture(createPiChatAgent(makeRuntime(fake, stubModel)));
    expect(result.error).toBeUndefined();
    expect(result.events.filter((event) => event.type === "started")).toHaveLength(1);
    expect(result.events).toEqual([
      { requestId: "req-1", type: "started" },
      { requestId: "req-1", type: "text_delta", delta: "你" },
      { requestId: "req-1", type: "text_delta", delta: "好" },
      { requestId: "req-1", type: "completed", text: "你好" },
    ]);
    expect(JSON.stringify(result.events)).not.toContain("sk-secret-test-key");
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
      events: [{ type: "agent_start" }, agentEnd([assistant("ok")])],
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
    agentEnd([assistant("ok")]),
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
      requestId: "smoke-1",
      kind: "chat.prompt",
      prompt: "只回复 OK",
      context: {
        conversationId: "c1",
        systemPrompt: "你是 Deepfield 的主 Agent",
        messages: [],
      },
      options: { webSearch: false },
      apiKey: process.env.DEEPSEEK_API_KEY ?? "",
      modelId: DEFAULT_DEEPSEEK_MODEL_ID,
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
