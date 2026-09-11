import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentWorkerEvent,
  type ChatMessage,
  type ChatRequestOptions,
} from "@deepfield/contracts";
import { ChatService, ChatServiceError, WEB_CHAT_POLICY, titleFromFirstMessage } from "./chat-service.js";
import { ContextBuilder } from "./context-builder.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";
import {
  chatEvent,
  FakeWorker,
  makeChatService as makeService,
  makeConversation,
  makeSecrets,
} from "./chat-service-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

describe("chat service", () => {
  it("snapshots LLM once and Search only for web-enabled messages", async () => {
    const db = openTestDb(); dbs.push(db); const worker = new FakeWorker(); const resolver = makeSecrets("sk-configured");
    const service = new ChatService(db.repos, new ContextBuilder(db.repos), resolver, worker); const conversation = makeConversation(db);
    await service.send(conversation.id, "联网问题", "req-web", () => {}, { webSearch: true });
    expect(resolver.getCalls).toBe(1); expect(resolver.searchCalls).toBe(1);
    expect(worker.requests[0]).toMatchObject({ toolAccess: WEB_CHAT_POLICY, search: { id: "search-1" }, llm: { id: "llm-1" } });
  });
  it("rejects blank content before any secret, db or worker access", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker();
    const contextBuilder = new ContextBuilder(db.repos);
    const secrets = makeSecrets("sk-configured");
    const service = new ChatService(db.repos, contextBuilder, secrets, worker);
    const conversation = makeConversation(db);

    await expect(service.send(conversation.id, "   ", "req-1", () => {})).rejects.toBeInstanceOf(
      ChatServiceError,
    );
    expect(secrets.getCalls).toBe(0);
    expect(worker.requests).toHaveLength(0);
    expect(db.repos.messages.listByConversation(conversation.id)).toEqual([]);
  });

  it("fails safely when the deepseek key is missing or blank", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker();
    const contextBuilder = new ContextBuilder(db.repos);
    const conversation = makeConversation(db);

    const missing = new ChatService(db.repos, contextBuilder, makeSecrets(undefined), worker);
    await expect(
      missing.send(conversation.id, "你好", "req-1", () => {}),
    ).rejects.toBeInstanceOf(ChatServiceError);
    expect(worker.requests).toHaveLength(0);
    expect(db.repos.messages.listByConversation(conversation.id)).toEqual([]);
    expect(db.repos.conversations.getById(conversation.id)!.hasUserMessage).toBe(false);
    expect(db.repos.conversations.listRecent()).toEqual([]);

    const blank = new ChatService(db.repos, contextBuilder, makeSecrets("   "), worker);
    await expect(
      blank.send(conversation.id, "你好", "req-1", () => {}),
    ).rejects.toBeInstanceOf(ChatServiceError);
    expect(worker.requests).toHaveLength(0);
  });

  it("fails safely when the conversation id does not exist", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker();
    const { service } = makeService(db, worker);

    await expect(service.send("missing-conversation", "你好", "req-1", () => {})).rejects.toThrow(
      /conversation not found/,
    );
    expect(worker.requests).toHaveLength(0);
  });

  it("sends the first standalone message: raw content persisted, deterministic title returned, no Project field, options forwarded", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [
        chatEvent(request.requestId, "started"),
        { requestId: request.requestId, type: "text_delta", delta: "测" },
        { requestId: request.requestId, type: "text_delta", delta: "试回" },
        { requestId: request.requestId, type: "completed", text: "测试回复" },
      ],
    });
    const { service, finished } = makeService(db, worker);
    const conversation = makeConversation(db);

    const forwarded: AgentWorkerEvent[] = [];
    let userMessageAtSend: ChatMessage | undefined;
    let contextMessagesAtSend: Array<{ role: string; content: string }> = [];
    let contextKeysAtSend: string[] = [];
    worker.onSend = (request) => {
      userMessageAtSend = db.repos.messages.listByConversation(conversation.id)[0];
      contextMessagesAtSend = request.context.messages;
      contextKeysAtSend = Object.keys(request.context);
    };

    const skillOptions: ChatRequestOptions = { webSearch: false, skillName: "structured-brief" };
    const content = "整理  人形机器人 行业目标";
    const result = await service.send(conversation.id, content, "req-1", (event) =>
      forwarded.push(event),
    skillOptions);
    expect(result.requestId).toBe("req-1");
    expect(result.conversation.id).toBe(conversation.id);
    expect(result.conversation.title).toBe(titleFromFirstMessage(content));
    expect(result.conversation.hasUserMessage).toBe(true);
    await finished.promise;

    expect(userMessageAtSend).toMatchObject({ role: "user", content });
    expect(contextMessagesAtSend.some((message) => message.content === content)).toBe(false);
    expect(contextMessagesAtSend.length).toBe(0);
    expect(contextKeysAtSend).not.toContain("projectId");

    expect(worker.requests).toHaveLength(1);
    const request = worker.requests[0]!;
    expect(request).toMatchObject({
      requestId: "req-1",
      kind: "chat.prompt",
      prompt: content,
      llm: expect.objectContaining({ modelId: "deepseek-v4-flash", apiKey: "sk-configured" }),
      toolAccess: { network: "disabled", maxAgentTurns: 6, maxSearchCalls: 0, maxFetchCalls: 0 },
      options: skillOptions,
    });
    expect(request.context.conversationId).toBe(conversation.id);
    expect(request.context).not.toHaveProperty("projectId");

    expect(forwarded).toEqual([
      { requestId: "req-1", type: "started" },
      { requestId: "req-1", type: "text_delta", delta: "测" },
      { requestId: "req-1", type: "text_delta", delta: "试回" },
      { requestId: "req-1", type: "completed", text: "测试回复" },
    ]);

    const messages = db.repos.messages.listByConversation(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "测试回复" });

    // Standalone Chat has no Project activity table or Project foreign key.
    const legacyActivityTable = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_activity_events'")
      .get();
    expect(legacyActivityTable).toBeUndefined();

    const recent = db.repos.conversations.listRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe(conversation.id);
    expect(recent[0]!.title).toBe(titleFromFirstMessage(content));
  });

  it("refreshes recency on later messages, keeps the first title and re-orders recent", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [chatEvent(request.requestId, "completed", "ok")],
    });
    const { service } = makeService(db, worker);
    const a = makeConversation(db);
    const b = makeConversation(db);

    const setUpdatedAt = (id: string, at: string): void => {
      db.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, id);
    };

    const firstA = await service.send(a.id, "甲 对话", "req-a1", () => {});
    expect(firstA.conversation.title).toBe("甲 对话");
    expect(firstA.conversation.hasUserMessage).toBe(true);
    await service.send(b.id, "乙 对话", "req-b1", () => {});

    // B is the newer Conversation until A speaks again: age A (2000) and B (2005).
    setUpdatedAt(a.id, "2000-01-01T00:00:00.000Z");
    setUpdatedAt(b.id, "2005-01-01T00:00:00.000Z");
    expect(db.repos.conversations.listRecent().map((conversation) => conversation.id)).toEqual([
      b.id,
      a.id,
    ]);

    const againA = await service.send(a.id, "甲 追问", "req-a2", () => {});
    expect(againA.conversation.title).toBe("甲 对话"); // first title is kept
    expect(againA.conversation.updatedAt).toBe(db.repos.conversations.getById(a.id)!.updatedAt);
    expect(againA.conversation.updatedAt > "2005-01-01T00:00:00.000Z").toBe(true);

    const users = db.repos.messages
      .listByConversation(a.id)
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    expect(users).toEqual(["甲 对话", "甲 追问"]);

    // A re-enters the top of recent after its later message.
    expect(db.repos.conversations.listRecent().map((conversation) => conversation.id)).toEqual([
      a.id,
      b.id,
    ]);
  });

  it("forwards a worker failed event without storing an assistant or activity", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [chatEvent(request.requestId, "failed", "provider_error")],
    });
    const { service, finished } = makeService(db, worker);
    const conversation = makeConversation(db);

    const forwarded: AgentWorkerEvent[] = [];
    await service.send(conversation.id, "你好", "req-1", (event) => forwarded.push(event));
    await finished.promise;

    expect(forwarded).toEqual([
      { requestId: "req-1", type: "failed", code: "provider_error", message: "boom" },
    ]);
    const messages = db.repos.messages.listByConversation(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(db.repos.conversations.getById(conversation.id)!.hasUserMessage).toBe(true);
    expect(db.repos.conversations.listRecent()).toHaveLength(1);
  });

  it("ignores events after the first terminal and persists at most once", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [chatEvent(request.requestId, "completed", "最终")],
      postTerminalEvents: [
        { requestId: "req-1", type: "text_delta", delta: "late" },
        chatEvent("req-1", "failed", "late_failure"),
      ],
    });
    const { service, finished } = makeService(db, worker);
    const conversation = makeConversation(db);

    const forwarded: AgentWorkerEvent[] = [];
    await service.send(conversation.id, "你好", "req-1", (event) => forwarded.push(event));
    await finished.promise;

    expect(forwarded).toEqual([{ requestId: "req-1", type: "completed", text: "最终" }]);
    const messages = db.repos.messages.listByConversation(conversation.id);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  it("uses an injectable request id factory", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [chatEvent(request.requestId, "completed", "ok")],
    });
    const { service, finished } = makeService(db, worker);
    const conversation = makeConversation(db);

    const result = await service.send(conversation.id, "你好", "custom-id-9", () => {});
    await finished.promise;

    expect(result.requestId).toBe("custom-id-9");
    expect(worker.requests[0]!.requestId).toBe("custom-id-9");
  });

  it("returns the request id immediately while consuming in the background", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({ neverEnds: true });
    const { service } = makeService(db, worker);
    const conversation = makeConversation(db);

    const result = await service.send(conversation.id, "你好", "req-1", () => {});
    expect(result.requestId).toBe("req-1");
    await new Promise((resolve) => setImmediate(resolve));
    expect(worker.requests).toHaveLength(1);
  });

  it("swallows a throwing renderer sink without unhandled rejection", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [
        chatEvent(request.requestId, "started"),
        chatEvent(request.requestId, "completed", "最终"),
      ],
    });
    const { service, finished } = makeService(db, worker);
    const conversation = makeConversation(db);

    let sinkCalls = 0;
    await service.send(conversation.id, "你好", "req-1", () => {
      sinkCalls += 1;
      throw new Error("sink destroyed");
    });
    await finished.promise;

    expect(sinkCalls).toBe(2);
    expect(db.repos.messages.listByConversation(conversation.id)).toHaveLength(2);
  });
});
