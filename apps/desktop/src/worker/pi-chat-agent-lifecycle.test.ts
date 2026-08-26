import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createPiChatAgent, PiChatAgentError } from "./pi-chat-agent.js";
import {
  agentEnd,
  assistant,
  capture,
  FakePiAgent,
  makeRuntime,
  request,
  stubModel,
  zeroUsage,
} from "./pi-chat-agent-test-helpers.js";

describe("pi chat agent lifecycle", () => {
  it("calls agent.abort and cleans up when the supplied signal aborts mid-run", async () => {
    const fake = new FakePiAgent({ events: [{ type: "agent_start" }], pending: true });
    const agent = createPiChatAgent(makeRuntime(fake, stubModel));
    const controller = new AbortController();
    const runPromise = agent.run(request(), () => {}, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(runPromise).rejects.toBeInstanceOf(PiChatAgentError);
    expect(fake.aborted).toBe(true);
    expect(fake.listenerCount).toBe(0);
  });

  it("calls agent.abort when the supplied signal is already aborted", async () => {
    const fake = new FakePiAgent({ events: [agentEnd([assistant("ok")])] });
    const agent = createPiChatAgent(makeRuntime(fake, stubModel));
    const controller = new AbortController();
    controller.abort();
    const result = await capture(agent, controller.signal);
    expect(result.error).toBeUndefined();
    expect(fake.aborted).toBe(true);
  });

  it("maps history, keeps the prompt out of history, disables tools/thinking and injects the key", async () => {
    const fake = new FakePiAgent({ events: [agentEnd([assistant("ok")])] });
    await capture(createPiChatAgent(makeRuntime(fake, stubModel)));

    const options = fake.receivedOptions!;
    const initialState = options.initialState!;
    expect(initialState.systemPrompt).toBe("sys");
    expect(initialState.thinkingLevel).toBe("off");
    expect(initialState.tools).toEqual([]);
    const messages = initialState.messages as unknown as Array<{
      role: string;
      timestamp?: number;
    }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", timestamp: 1 });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      model: "deepseek-v4-flash",
      timestamp: 2,
    });
    const assistantMessage = messages[1] as unknown as AssistantMessage;
    expect(assistantMessage.content).toEqual([{ type: "text", text: "历史助手" }]);
    expect(assistantMessage.usage).toEqual(zeroUsage());
    expect(JSON.stringify(initialState.messages)).not.toContain("当前问题");
    expect(fake.promptedWith).toBe("当前问题");
    expect(await options.getApiKey?.("deepseek")).toBe("sk-secret-test-key");
    expect(await options.getApiKey?.("other")).toBeUndefined();
  });

  it("fails safely when the deepseek model is unavailable", async () => {
    const fake = new FakePiAgent({ events: [] });
    const result = await capture(createPiChatAgent(makeRuntime(fake, undefined)));
    expect(result.error).toBeInstanceOf(PiChatAgentError);
    expect(result.error?.message).not.toContain("sk-secret-test-key");
    expect(result.error?.message).not.toContain("当前问题");
  });
});
