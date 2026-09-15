import { describe, expect, it } from "vitest";
import { mapHistoryMessages } from "./pi-message-mapper.js";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";

const model = { id: "deepseek-flash", api: "openai-completions", provider: "deepseek" };

describe("pi message mapper", () => {
  it("maps user history to a UserMessage", () => {
    const [message] = mapHistoryMessages(
      [{ role: "user", content: "你好", timestamp: 1700000000000 }],
      model,
    );
    expect(message).toMatchObject({ role: "user", timestamp: 1700000000000 });
    expect((message as UserMessage).content).toBe("你好");
  });

  it("maps assistant history to a full AssistantMessage with zeroed usage", () => {
    const [message] = mapHistoryMessages(
      [{ role: "assistant", content: "世界", timestamp: 1700000001000 }],
      model,
    );
    expect(message).toMatchObject({
      role: "assistant",
      api: "openai-completions",
      provider: "deepseek",
      model: "deepseek-flash",
      stopReason: "stop",
      timestamp: 1700000001000,
    });
    const assistant = message as AssistantMessage;
    expect(assistant.content).toEqual([{ type: "text", text: "世界" }]);
    expect(assistant.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("preserves mixed order and never injects extra messages", () => {
    const messages = mapHistoryMessages(
      [
        { role: "user", content: "a", timestamp: 1 },
        { role: "assistant", content: "b", timestamp: 2 },
        { role: "user", content: "c", timestamp: 3 },
      ],
      model,
    );
    expect(messages).toHaveLength(3);
    expect((messages[0] as Message).role).toBe("user");
    expect((messages[1] as Message).role).toBe("assistant");
    expect((messages[2] as Message).role).toBe("user");
  });
});
