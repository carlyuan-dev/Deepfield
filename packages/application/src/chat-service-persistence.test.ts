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
  it("makes the assistant message durable before forwarding completed and writes no activity", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [
        chatEvent(request.requestId, "started"),
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
    expect(forwarded[forwarded.length - 1]).toEqual({
      requestId: "req-1",
      type: "completed",
      text: "测试回复",
    });
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
