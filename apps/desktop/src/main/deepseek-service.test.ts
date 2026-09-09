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
  it("recognizes deduplicated company drafts and exposes only a fixed safe failure", async () => {
    const chunk = "输入中出现的公司".repeat(400);
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(input).toBe("https://api.deepseek.com/chat/completions");
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
        response_format?: { type?: string };
        max_tokens?: number;
      };
      expect(body.messages[0]?.content).toContain("只提取");
      expect(body.messages[0]?.content).toContain("极简");
      expect(body.messages[1]?.content).toBe(chunk);
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.max_tokens).toBe(2048);
      expect(String(init?.body)).not.toContain("sk-secret");
      return response({
        choices: [
          {
            message: {
              content: JSON.stringify({
                companies: [
                  { name: " ＡＣＭＥ  Corp ", countryOrRegion: "US", note: "候选" },
                  { name: "acme corp", countryOrRegion: "US" },
                  { name: "   " },
                  { name: "Beta Labs", countryOrRegion: "UK" },
                ],
              }),
            },
          },
        ],
      });
    });
    const service = new DeepSeekService(secrets("sk-secret"), { fetch });

    await expect(service.recognize(chunk)).resolves.toEqual([
      { name: "ＡＣＭＥ  Corp", countryOrRegion: "US", note: "候选" },
      { name: "Beta Labs", countryOrRegion: "UK" },
    ]);

    const failed = new DeepSeekService(secrets("sk-secret"), {
      fetch: vi.fn<typeof globalThis.fetch>(async () => {
        throw new Error("provider response contains sk-secret");
      }),
    });
    const error = await failed.recognize("测试").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("company recognition failed");
    expect((error as Error).message).not.toContain("sk-secret");

    await expect(service.recognize("字".repeat(4001))).rejects.toThrow(
      "company recognition failed",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the default recognition request alive beyond seven seconds", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        signal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      });
      const service = new DeepSeekService(secrets("sk-test"), { fetch });
      const result = expect(service.recognize("公司甲")).rejects.toThrow("company recognition failed");

      await vi.advanceTimersByTimeAsync(7001);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(12999);
      expect(signal?.aborted).toBe(true);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps ordinary requests on the seven-second default timeout", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
        signal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      });
      const result = expect(
        new DeepSeekService(secrets("sk-test"), { fetch }).checkConnection(),
      ).resolves.toBe("disconnected");

      await vi.advanceTimersByTimeAsync(6999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

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
