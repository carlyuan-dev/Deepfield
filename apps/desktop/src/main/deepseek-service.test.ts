import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DEEPSEEK_MODEL_ID } from "@deepfield/contracts";
import { ChatService, ContextBuilder } from "@deepfield/application";
import { openTestDb } from "../../../../packages/application/src/application-test-helpers.js";
import {
  FakeWorker,
  makeConversation,
  makeSecrets,
} from "../../../../packages/application/src/chat-service-helpers.js";
import { DeepSeekService } from "./deepseek-service.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function secrets(value: string | undefined) {
  return { get: (name: string) => (name === "deepseek.apiKey" ? value : undefined) };
}

describe("DeepSeekService", () => {
  it("reports connected only when the configured default model is available", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input).toBe("https://api.deepseek.com/models");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer sk-test");
      return response({ data: [{ id: DEFAULT_DEEPSEEK_MODEL_ID }] });
    });
    const service = new DeepSeekService(secrets("sk-test"), { fetch });

    await expect(service.checkConnection()).resolves.toBe("connected");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("hides missing, unavailable, and malformed connection failures", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ data: [] }, 401));
    await expect(new DeepSeekService(secrets(undefined), { fetch }).checkConnection()).resolves.toBe(
      "disconnected",
    );
    expect(fetch).not.toHaveBeenCalled();
    await expect(new DeepSeekService(secrets("sk-test"), { fetch }).checkConnection()).resolves.toBe(
      "disconnected",
    );
  });

  it("does not access secrets or fetch when disabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = new DeepSeekService(secrets("sk-test"), { fetch, enabled: false });

    await expect(service.checkConnection()).resolves.toBe("disconnected");
    await expect(service.generateConversationTitle("首条消息")).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes a generated title and uses a bounded non-streaming request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input).toBe("https://api.deepseek.com/chat/completions");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: DEFAULT_DEEPSEEK_MODEL_ID, stream: false, max_tokens: 32 });
      return response({
        choices: [{ message: { content: '标题： “ 人形机器人 研究进展  ”\n多余内容' } }],
      });
    });
    const service = new DeepSeekService(secrets("sk-test"), { fetch });

    const longMessage = "请整理人形机器人行业最新进展".repeat(200);
    await expect(service.generateConversationTitle(longMessage)).resolves.toBe(
      "人形机器人 研究进展",
    );
    const requestBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(requestBody.messages[1]?.content).toHaveLength(2000);
  });

  it("generates a title only for the first Chat message and persists it without changing recency", async () => {
    const db = openTestDb();
    try {
      const worker = new FakeWorker({
        events: (request) => [{ requestId: request.requestId, type: "completed", text: "回复" }],
      });
      const titleGenerator = {
        calls: [] as string[],
        generateConversationTitle: async (content: string): Promise<string> => {
          titleGenerator.calls.push(content);
          return "智能标题";
        },
      };
      const service = new ChatService(
        db.repos,
        new ContextBuilder(db.repos),
        makeSecrets("sk-test"),
        worker,
        { titleGenerator },
      );
      const conversation = makeConversation(db);

      const first = await service.send(conversation.id, "首条消息", "req-1", () => {});
      const second = await service.send(conversation.id, "后续消息", "req-2", () => {});

      expect(first.conversation.title).toBe("智能标题");
      expect(second.conversation.title).toBe("智能标题");
      expect(titleGenerator.calls).toEqual(["首条消息"]);
      expect(db.repos.conversations.getById(conversation.id)?.title).toBe("智能标题");
    } finally {
      db.cleanup();
    }
  });
});
