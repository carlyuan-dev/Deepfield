import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEEPSEEK_MODEL_ID,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from "@deepfield/contracts";
import { createFakeChatAgent } from "./fake-chat-agent.js";

function request(): AgentWorkerRequest {
  return {
    requestId: "req-1",
    kind: "chat.prompt",
    prompt: "当前问题",
    context: { projectId: "p1", conversationId: "c1", systemPrompt: "sys", messages: [] },
    apiKey: "sk-fake-secret",
    modelId: DEFAULT_DEEPSEEK_MODEL_ID,
  };
}

describe("fake chat agent", () => {
  it("streams three deltas and one completed with exact 测试回复", async () => {
    const agent = createFakeChatAgent((callback) => callback());
    const events: AgentWorkerEvent[] = [];
    await agent.run(request(), (event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([
      { requestId: "req-1", type: "started" },
      { requestId: "req-1", type: "text_delta", delta: "测" },
      { requestId: "req-1", type: "text_delta", delta: "试回" },
      { requestId: "req-1", type: "text_delta", delta: "复" },
      { requestId: "req-1", type: "completed", text: "测试回复" },
    ]);
  });

  it("never touches, prints or echoes the api key or prompt", async () => {
    const agent = createFakeChatAgent((callback) => callback());
    const events: AgentWorkerEvent[] = [];
    await agent.run(request(), (event) => events.push(event), new AbortController().signal);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("sk-fake-secret");
    expect(serialized).not.toContain("当前问题");
  });
});
