import { afterEach, describe, expect, it } from "vitest";
import { ChatService, ChatServiceError } from "./chat-service.js";
import { ContextBuilder } from "./context-builder.js";
import { openTestDb, type TestDb } from "../testing/application-test-helpers.js";
import { deferred, FakeWorker, makeChatService, makeConversation, makeSecrets } from "./chat-service-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

function makeService(db: TestDb): ChatService {
  return new ChatService(
    db.repos,
    new ContextBuilder(db.repos),
    makeSecrets("sk-configured"),
    new FakeWorker(),
  );
}

describe("chat history query", () => {
  it("projects an unfinished tool turn as interrupted only when its request is no longer active", async () => {
    const db = openTestDb();
    dbs.push(db);
    const release = deferred();
    const activityPersisted = deferred();
    const worker = new FakeWorker();
    worker.send = (request) => (async function* () {
      yield { requestId: request.requestId, type: "tool_activity" as const, callKey: "memory-call", name: "memory_search", status: "running" as const };
      await release.promise;
      yield { requestId: request.requestId, type: "completed" as const, text: "回答" };
    })();
    const { service, finished } = makeChatService(db, worker);
    const conversation = makeConversation(db);
    await service.send(conversation.id, "问题", "req-active", (event) => {
      if (event.type === "tool_activity") activityPersisted.resolve();
    });
    await activityPersisted.promise;

    try {
      expect(service.listMessages(conversation.id)).toMatchObject([
        { role: "user", requestId: "req-active", content: "问题" },
      ]);
      const restored = makeService(db).listMessages(conversation.id);
      expect(restored).toMatchObject([
        { role: "user", requestId: "req-active" },
        { role: "assistant", requestId: "req-active", status: "failed", toolExecutions: [{ name: "memory_search", status: "failed" }] },
      ]);
      expect(db.repos.chatSessions.list(conversation.id)[0]).toMatchObject({
        completed: false, activities: [{ status: "running" }],
      });
      expect(db.repos.chatSessions.list(conversation.id)[0]?.failed).not.toBe(true);
    } finally {
      release.resolve();
      await finished.promise;
    }
    expect(service.listMessages(conversation.id)).toMatchObject([
      { role: "user", requestId: "req-active" },
      { role: "assistant", requestId: "req-active", content: "回答" },
    ]);
  });

  it("returns the conversation messages in chronological order", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = makeService(db);
    const conversation = makeConversation(db);
    db.repos.messages.append(conversation.id, "user", "a");
    db.repos.messages.append(conversation.id, "assistant", "b");
    db.repos.messages.append(conversation.id, "user", "c");

    const messages = service.listMessages(conversation.id);
    expect(messages.map((message) => message.content)).toEqual(["a", "b", "c"]);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages.every((message) => message.id.length > 0 && message.createdAt.length > 0)).toBe(
      true,
    );
  });

  it("fails safely when the conversation is missing", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = makeService(db);
    expect(() => service.listMessages("missing-conversation")).toThrow(ChatServiceError);
    expect(() => service.listMessages("missing-conversation")).toThrow(/conversation/);
  });
});
