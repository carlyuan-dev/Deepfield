import { afterEach, describe, expect, it } from "vitest";
import type { ConversationId } from "@deepfield/contracts";
import { ContextBuilder, ContextBuilderError, MAIN_AGENT_SYSTEM_PROMPT } from "./context-builder.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

describe("context builder", () => {
  it("builds a general main-Agent snapshot with no Project field", () => {
    const db = openTestDb();
    dbs.push(db);
    const builder = new ContextBuilder(db.repos);
    const conversation = db.repos.conversations.create();

    const snapshot = builder.build(conversation.id);
    expect(snapshot.systemPrompt).toBe(MAIN_AGENT_SYSTEM_PROMPT);
    expect(snapshot.systemPrompt).toContain("你是 Deepfield 的主 Agent");
    expect(snapshot.systemPrompt).not.toContain("当前项目");
    expect(snapshot).not.toHaveProperty("projectId");
    expect(snapshot.conversationId).toBe(conversation.id);
  });

  it("returns the latest 40 messages in chronological order", () => {
    const db = openTestDb();
    dbs.push(db);
    const builder = new ContextBuilder(db.repos);
    const conversation = db.repos.conversations.create();
    for (let index = 0; index < 45; index += 1) {
      db.repos.messages.append(
        conversation.id,
        index % 2 === 0 ? "user" : "assistant",
        `m${index}`,
      );
    }

    const snapshot = builder.build(conversation.id);
    expect(snapshot.messages).toHaveLength(40);
    expect(snapshot.messages[0]!.content).toBe("m5");
    expect(snapshot.messages[39]!.content).toBe("m44");
    expect(snapshot.messages[0]!.timestamp).toBeTypeOf("number");
  });

  it("excludes the current user message by id while keeping 40", () => {
    const db = openTestDb();
    dbs.push(db);
    const builder = new ContextBuilder(db.repos);
    const conversation = db.repos.conversations.create();
    for (let index = 0; index < 45; index += 1) {
      db.repos.messages.append(
        conversation.id,
        index % 2 === 0 ? "user" : "assistant",
        `m${index}`,
      );
    }
    const all = db.repos.messages.listByConversation(conversation.id);
    const current = all[44]!;

    const snapshot = builder.build(conversation.id, { excludeMessageId: current.id });
    expect(snapshot.messages).toHaveLength(40);
    expect(snapshot.messages.some((message) => message.content === "m44")).toBe(false);
    expect(snapshot.messages[39]!.content).toBe("m43");
  });

  it("fails safely when the conversation is missing", () => {
    const db = openTestDb();
    dbs.push(db);
    const builder = new ContextBuilder(db.repos);

    expect(() => builder.build("missing-conversation" as ConversationId)).toThrow(
      ContextBuilderError,
    );
  });
});
