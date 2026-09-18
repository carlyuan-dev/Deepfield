import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ToolBudgetSnapshot } from "@deepfield/tool-platform";
import { createPiChatAgent } from "./pi-chat-agent.js";
import {
  assistant,
  capture,
  makeRecordingInstalledPiRuntime,
  request,
} from "./pi-chat-agent-test-helpers.js";

function toolTurn(
  id: string,
  name: string,
  args: Record<string, unknown>,
  text = "",
): AssistantMessage {
  return assistant(text, {
    content: [
      ...(text.length === 0 ? [] : [{ type: "text" as const, text }]),
      { type: "toolCall", id, name, arguments: args },
    ],
    stopReason: "toolUse",
  });
}

function budgetSnapshot(searchRemaining: number, fetchRemaining: number): ToolBudgetSnapshot {
  const dimension = (limit: number, remaining: number) => ({
    limit,
    reserved: 0,
    consumed: limit - remaining,
    remaining,
    exhausted: remaining === 0,
  });
  return {
    total: dimension(2, searchRemaining + fetchRemaining),
    categories: {
      search: dimension(1, searchRemaining),
      fetch: dimension(1, fetchRemaining),
      link_check: { reserved: 0, consumed: 0, exhausted: false },
      parse: { reserved: 0, consumed: 0, exhausted: false },
      none: { reserved: 0, consumed: 0, exhausted: false },
    },
  };
}

function searchSessions(options: { fail?: boolean } = {}) {
  let searchRemaining = 1;
  return {
    createAgentTools: () => [{
      name: "web_search",
      description: "search",
      label: "search",
      parameters: Type.Object({ query: Type.String() }),
      async execute() {
        searchRemaining = 0;
        if (options.fail) throw new Error("search failed");
        return {
          content: [{ type: "text" as const, text: '{"results":[{"url":"https://example.test"}]}' }],
          details: { budgetConsumed: true },
        };
      },
    }],
    bindSearchProvider: () => undefined,
    budgetSnapshot: () => budgetSnapshot(searchRemaining, 0),
    recordSynthetic: async () => undefined,
    releaseTrace: () => true,
  };
}

const memoryTool = (
  executions: string[],
): AgentTool<any> => ({
  name: "remember_value",
  description: "Remember an in-memory value",
  label: "remember",
  parameters: Type.Object({ value: Type.String() }),
  async execute(_toolCallId, params) {
    const value = typeof params === "object" && params !== null &&
      typeof (params as { value?: unknown }).value === "string"
      ? (params as { value: string }).value
      : "";
    executions.push(value);
    return { content: [{ type: "text", text: `remembered:${value}` }], details: {} };
  },
});

describe("generic Pi chat loop", () => {
  it("uses one request for an online natural answer and streams provider chunks", async () => {
    const finalText = "这是无需工具即可直接给出的自然回答。";
    const recording = makeRecordingInstalledPiRuntime([assistant(finalText, {
      content: [
        { type: "text", text: "这是无需工具即可" },
        { type: "text", text: "直接给出的自然回答。" },
      ],
    })]);

    const result = await capture(
      createPiChatAgent(recording.runtime, [], undefined, {}, searchSessions()),
      undefined,
      request({ webSearch: true }),
    );

    const deltas = result.events.flatMap((event) => event.type === "text_delta" ? [event.delta] : []);
    expect(result.error).toBeUndefined();
    expect(recording.requests).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas).not.toContain(finalText);
    expect(deltas.join("")).toBe(finalText);
  });

  it("continues natively from search to a natural answer without a synthesis request", async () => {
    const recording = makeRecordingInstalledPiRuntime([
      toolTurn("search-1", "web_search", { query: "recent" }, "我先查一下"),
      assistant("搜索后的自然答案"),
    ]);

    const result = await capture(
      createPiChatAgent(recording.runtime, [], undefined, {}, searchSessions()),
      undefined,
      request({ webSearch: true }),
    );

    expect(result.error).toBeUndefined();
    expect(recording.requests).toHaveLength(2);
    expect(result.events.some((event) => event.type === "text_reset")).toBe(true);
    expect(result.events.at(-1)).toEqual({
      requestId: "req-1",
      type: "completed",
      text: "搜索后的自然答案",
    });
    expect(recording.requests[1]?.messages.some((message) => message.role === "toolResult")).toBe(true);
  });

  it("keeps a non-network tool available after search is exhausted", async () => {
    const executions: string[] = [];
    const recording = makeRecordingInstalledPiRuntime([
      toolTurn("search-1", "web_search", { query: "recent" }),
      toolTurn("memory-2", "remember_value", { value: "still-available" }),
      assistant("完成"),
    ]);
    const webRequest = request({ webSearch: true });
    webRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns: 4,
      maxSearchCalls: 1,
      maxFetchCalls: 0,
    };

    const result = await capture(
      createPiChatAgent(recording.runtime, [memoryTool(executions)], undefined, {}, searchSessions()),
      undefined,
      webRequest,
    );

    expect(result.error).toBeUndefined();
    expect(recording.requests).toHaveLength(3);
    expect(recording.requests[1]?.tools.map((tool) => tool.name)).toEqual(["remember_value"]);
    expect(executions).toEqual(["still-available"]);
  });

  it("filters injected network tools while retaining non-network tools offline", async () => {
    const executions: string[] = [];
    const networkExecutions: string[] = [];
    const injectedNetworkTool: AgentTool<any> = {
      name: "web_search",
      description: "must remain unavailable offline",
      label: "search",
      parameters: Type.Object({ query: Type.String() }),
      async execute() {
        networkExecutions.push("web_search");
        return { content: [{ type: "text", text: "unexpected" }], details: {} };
      },
    };
    const recording = makeRecordingInstalledPiRuntime([
      toolTurn("memory-1", "remember_value", { value: "offline" }),
      assistant("离线工具已完成"),
    ]);

    const result = await capture(
      createPiChatAgent(recording.runtime, [injectedNetworkTool, memoryTool(executions)]),
    );

    expect(result.error).toBeUndefined();
    expect(recording.requests).toHaveLength(2);
    expect(recording.requests.every((providerRequest) =>
      providerRequest.tools.map((tool) => tool.name).join(",") === "remember_value"
    )).toBe(true);
    expect(executions).toEqual(["offline"]);
    expect(networkExecutions).toEqual([]);
  });

  it.each([
    ["result", false],
    ["error", true],
  ])("carries the final permitted tool %s into the paired zero-tool request", async (_label, fail) => {
    const recording = makeRecordingInstalledPiRuntime([
      toolTurn("search-1", "web_search", { query: "recent" }),
      assistant("达到总轮次上限后的答案"),
    ]);
    const webRequest = request({ webSearch: true });
    webRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns: 2,
      maxSearchCalls: 1,
      maxFetchCalls: 0,
    };

    const result = await capture(
      createPiChatAgent(recording.runtime, [], undefined, {}, searchSessions({ fail })),
      undefined,
      webRequest,
    );

    expect(result.error).toBeUndefined();
    expect(recording.requests).toHaveLength(2);
    expect(recording.requests[1]?.tools).toEqual([]);
    expect(recording.requests[1]?.toolChoice).toBe("none");
    expect(recording.requests[1]?.messages.some((message) =>
      message.role === "assistant" && message.content.some((part) => part.type === "toolCall")
    )).toBe(true);
    expect(recording.requests[1]?.messages.some((message) =>
      message.role === "toolResult" && message.isError === fail
    )).toBe(true);
  });

  it("starts maxAgentTurns one with zero tools and toolChoice none", async () => {
    const executions: string[] = [];
    const recording = makeRecordingInstalledPiRuntime([assistant("单轮答案")]);
    const webRequest = request({ webSearch: true });
    webRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns: 1,
      maxSearchCalls: 1,
      maxFetchCalls: 0,
    };

    const result = await capture(
      createPiChatAgent(
        recording.runtime,
        [memoryTool(executions)],
        undefined,
        {},
        searchSessions(),
      ),
      undefined,
      webRequest,
    );

    expect(result.error).toBeUndefined();
    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.tools).toEqual([]);
    expect(recording.requests[0]?.toolChoice).toBe("none");
    expect(executions).toEqual([]);
  });

  it("keeps Capability structured finalization isolated from generic Chat", async () => {
    const recording = makeRecordingInstalledPiRuntime([
      toolTurn("search-1", "web_search", { query: "company" }),
      assistant('{"公司":"Deepfield"}'),
    ]);
    const capabilityRequest = request({ webSearch: true });
    capabilityRequest.context.finalizationSystemPrompt = "只输出结构化 JSON";
    capabilityRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns: 2,
      maxSearchCalls: 1,
      maxFetchCalls: 0,
    };

    const result = await capture(
      createPiChatAgent(
        recording.runtime,
        [],
        undefined,
        {},
        searchSessions(),
        undefined,
        undefined,
        "capability",
      ),
      undefined,
      capabilityRequest,
    );

    expect(result.error).toBeUndefined();
    expect(recording.requests[1]?.systemPrompt).toContain("只输出结构化 JSON");
    expect(recording.requests[1]?.tools).toEqual([]);
    expect(recording.requests[1]?.toolChoice).toBe("none");
    expect(result.events.some((event) => event.type === "text_reset")).toBe(false);
  });
});
