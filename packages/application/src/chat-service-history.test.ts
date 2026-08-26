import { afterEach, describe, expect, it } from "vitest";
import { ChatService, ChatServiceError } from "./chat-service.js";
import { ContextBuilder } from "./context-builder.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";
import { FakeWorker, makeProject, makeSecrets } from "./chat-service-helpers.js";

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
  it("returns the conversation messages in chronological order", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = makeService(db);
    const { project, conversation } = makeProject(db);
    db.repos.messages.append(conversation.id, "user", "a");
    db.repos.messages.append(conversation.id, "assistant", "b");
    db.repos.messages.append(conversation.id, "user", "c");

    const messages = service.listMessages(project.id);
    expect(messages.map((message) => message.content)).toEqual(["a", "b", "c"]);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages.every((message) => message.id.length > 0 && message.createdAt.length > 0)).toBe(
      true,
    );
  });

  it("fails safely when the project is missing", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = makeService(db);
    expect(() => service.listMessages("missing-project")).toThrow(ChatServiceError);
  });

  it("fails safely when the conversation is missing", () => {
    const db = openTestDb();
    dbs.push(db);
    const service = makeService(db);
    db.db
      .prepare(
        "INSERT INTO projects(id, industry, scope_json, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)",
      )
      .run("orphan", "孤儿项目", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    expect(() => service.listMessages("orphan")).toThrow(/conversation/);
  });
});
