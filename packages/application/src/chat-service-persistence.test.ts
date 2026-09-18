import { afterEach, describe, expect, it } from "vitest";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import { ChatService, ChatServiceError } from "./chat-service.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";
import {
  chatEvent,
  FakeWorker,
  makeChatService,
  makeConversation,
} from "./chat-service-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

describe("chat service persistence guarantees", () => {
  it("consumes internal checkpoints, persists live tool details and restores failed request activity", async () => {
    const db = openTestDb(); dbs.push(db);
    const worker = new FakeWorker({ events: request => [
      { requestId: request.requestId, type: "transcript_checkpoint", messages: [{ role: "user", content: "question", timestamp: 1 }] },
      { requestId: request.requestId, type: "tool_activity", callKey: "stable-call", toolCallId: "call-1", name: "web_search", status: "completed", summary: "original query", queryOrUrl: "original query", sources: [{ title: "Source", url: "https://example.test/original" }], resultCount: 1, durationMs: 10 },
      { requestId: request.requestId, type: "failed", code: "cancelled", message: "cancelled" },
    ] });
    const { service, finished } = makeChatService(db, worker);
    const conversation = makeConversation(db);
    const forwarded: AgentWorkerEvent[] = [];
    await service.send(conversation.id, "question", "req-checkpoint", event => forwarded.push(event));
    await finished.promise;
    expect(forwarded.some(event => event.type === "transcript_checkpoint")).toBe(false);
    expect(db.repos.chatSessions.list(conversation.id)[0]).toMatchObject({ network: "disabled", completed: false, failed: true, messages: [{ role: "user", content: "question" }] });
    const restored = service.listMessages(conversation.id);
    expect(restored[1]).toMatchObject({ status: "failed", content: "", toolExecutions: [{ queryOrUrl: "original query", sources: [{ url: "https://example.test/original" }], resultCount: 1, durationMs: 10 }] });
    expect(db.repos.messages.listByConversation(conversation.id)).toHaveLength(1);
  });
  it("makes the assistant message durable before forwarding completed and writes no activity", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [
        chatEvent(request.requestId, "started"),
        { requestId: request.requestId, type: "transcript_checkpoint", messages: [{ role: "user", content: request.prompt, timestamp: 1 }] },
        { requestId: request.requestId, type: "completed", text: "测试回复" },
      ],
    });
    const { service, finished } = makeChatService(db, worker);
    const conversation = makeConversation(db);
    const forwarded: AgentWorkerEvent[] = [];
    let assistantDurableAtCompleted = false;

    await service.send(conversation.id, "你好", "req-1", (event) => {
      forwarded.push(event);
      if (event.type === "completed") {
        assistantDurableAtCompleted = db.repos.messages
          .listByConversation(conversation.id)
          .some((message) => message.role === "assistant" && message.content === "测试回复");
      }
    });
    await finished.promise;

    expect(assistantDurableAtCompleted).toBe(true);
    expect(db.repos.chatSessions.list(conversation.id)[0]?.completed).toBe(true);
    expect(forwarded.some(event => event.type === "transcript_checkpoint")).toBe(false);
    expect(forwarded[forwarded.length - 1]).toEqual({
      requestId: "req-1",
      type: "completed",
      text: "测试回复",
    });
    expect(db.repos.messages.listByConversation(conversation.id)).toMatchObject([
      { role: "user", requestId: "req-1" },
      { role: "assistant", requestId: "req-1" },
    ]);
  });

  it("returns bounded safe tool history on the associated assistant message", async () => {
    const db = openTestDb(); dbs.push(db); const conversation = makeConversation(db);
    (db.repos.messages.append as any)(conversation.id, "user", "问题", "req-history");
    (db.repos.messages.append as any)(conversation.id, "assistant", "回答", "req-history");
    db.repos.toolExecutions.start({ id: "tool-history", traceId: "req-history", actor: "main_agent", toolName: "fetch_url", toolVersion: 1, inputSummary: { secret: "never" }, startedAt: "2026-09-14T00:00:00.000Z" });
    db.repos.toolExecutions.finish({ id: "tool-history", status: "failed", errorCode: "timeout", attempts: 1, retries: 0, bytesReceived: 0, resultCount: 0, finishedAt: "2026-09-14T00:00:02.000Z", durationMs: 2000 });
    const messages = new ChatService(db.repos, {} as never, {} as never, {} as never).listMessages(conversation.id);
    expect(messages[1]).toMatchObject({ toolExecutions: [{ callKey: "tool-history", name: "fetch_url", status: "failed", durationMs: 2000, errorCode: "timeout" }] });
    expect(JSON.stringify(messages)).not.toContain("never");
  });

  it("restores batch-scoped skipped, reused and pre-dispatch failed activity", () => {
    const db = openTestDb(); dbs.push(db); const conversation = makeConversation(db);
    (db.repos.messages.append as any)(conversation.id, "user", "问题", "req-batch");
    (db.repos.messages.append as any)(conversation.id, "assistant", "回答", "req-batch");
    db.repos.toolExecutions.recordSynthetic({
      id: "skip-history",
      traceId: "req-batch",
      actor: "main_agent",
      toolName: "web_search",
      toolVersion: 1,
      status: "skipped",
      errorCode: "budget_trimmed",
      agentTurnIndex: 3,
      batchId: "batch-3",
      toolCallId: "call-7",
      attempts: 0,
      budgetConsumed: false,
      startedAt: "2026-09-14T00:00:00.000Z",
      finishedAt: "2026-09-14T00:00:00.000Z",
    });
    db.repos.toolExecutions.recordSynthetic({
      id: "reuse-history",
      traceId: "req-batch",
      actor: "main_agent",
      toolName: "read_webpage",
      toolVersion: 1,
      status: "reused",
      agentTurnIndex: 3,
      batchId: "batch-3",
      toolCallId: "call-8",
      attempts: 0,
      budgetConsumed: false,
      startedAt: "2026-09-14T00:00:00.000Z",
      finishedAt: "2026-09-14T00:00:00.000Z",
    });
    db.repos.toolExecutions.recordSynthetic({
      id: "invalid-call-key",
      traceId: "req-batch",
      actor: "main_agent",
      toolName: "web_search",
      toolVersion: 1,
      status: "failed",
      errorCode: "invalid_input",
      agentTurnIndex: 1,
      batchId: "batch-1",
      toolCallId: "invalid-first",
      attempts: 0,
      budgetConsumed: false,
      startedAt: "2026-09-14T00:00:00.000Z",
      finishedAt: "2026-09-14T00:00:00.000Z",
    });

    const messages = new ChatService(db.repos, {} as never, {} as never, {} as never).listMessages(conversation.id);
    expect(messages[1]?.toolExecutions).toEqual([
      {
        callKey: "invalid-call-key",
        name: "web_search",
        status: "failed",
        errorCode: "invalid_input",
        agentTurnIndex: 1,
        batchId: "batch-1",
        toolCallId: "invalid-first",
        budgetConsumed: false,
      },
      {
        callKey: "reuse-history",
        name: "read_webpage",
        status: "reused",
        agentTurnIndex: 3,
        batchId: "batch-3",
        toolCallId: "call-8",
        budgetConsumed: false,
      },
      {
        callKey: "skip-history",
        name: "web_search",
        status: "skipped",
        errorCode: "budget_trimmed",
        agentTurnIndex: 3,
        batchId: "batch-3",
        toolCallId: "call-7",
        budgetConsumed: false,
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("inputSummary");
    expect(JSON.stringify(messages)).not.toContain("outputSummary");
  });

  it("rolls back and emits chat_persistence_failed when the assistant insert fails", async () => {
    const db = openTestDb();
    dbs.push(db);
    db.db.exec(
      "CREATE TRIGGER fail_assistant BEFORE INSERT ON messages WHEN NEW.role = 'assistant' AND NEW.content = 'FORCE_FAIL' BEGIN SELECT RAISE(ABORT, 'forced assistant failure'); END;",
    );
    const worker = new FakeWorker({
      events: (request) => [
        chatEvent(request.requestId, "started"),
        { requestId: request.requestId, type: "completed", text: "FORCE_FAIL" },
      ],
    });
    const { service, finished } = makeChatService(db, worker);
    const conversation = makeConversation(db);
    const forwarded: AgentWorkerEvent[] = [];

    await service.send(conversation.id, "你好", "req-1", (event) => forwarded.push(event));
    await finished.promise;

    expect(forwarded.some((event) => event.type === "completed")).toBe(false);
    expect(forwarded[forwarded.length - 1]).toEqual({
      requestId: "req-1",
      type: "failed",
      code: "chat_persistence_failed",
      message: "chat request failed",
    });
    expect(JSON.stringify(forwarded)).not.toContain("forced assistant failure");
    const messages = db.repos.messages.listByConversation(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages.some((message) => message.role === "assistant")).toBe(false);
  });

  it("rolls back the user insert when activating the conversation fails", async () => {
    const db = openTestDb();
    dbs.push(db);
    const conversation = makeConversation(db);
    db.db.exec(
      `CREATE TRIGGER fail_mark BEFORE UPDATE OF has_user_message ON conversations WHEN NEW.id = '${conversation.id}' AND NEW.has_user_message = 1 BEGIN SELECT RAISE(ABORT, 'forced mark failure'); END;`,
    );
    const worker = new FakeWorker();
    const { service } = makeChatService(db, worker);

    await expect(service.send(conversation.id, "你好", "req-1", () => {})).rejects.toBeInstanceOf(
      ChatServiceError,
    );
    expect(worker.requests).toHaveLength(0);
    expect(db.repos.messages.listByConversation(conversation.id)).toEqual([]);
    expect(db.repos.conversations.getById(conversation.id)!.hasUserMessage).toBe(false);
  });
});
