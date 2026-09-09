import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { ConversationId } from "@deepfield/contracts";
import { openDatabase, migrate, createRepositories } from "./index.js";

interface TestDb {
  dir: string;
  path: string;
  db: DatabaseSync;
}

const openHandles: TestDb[] = [];

function openTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "deepfield-db-"));
  const path = join(dir, "deepfield.sqlite");
  const db = openDatabase(path);
  migrate(db);
  openHandles.push({ dir, path, db });
  return { dir, path, db };
}

afterEach(() => {
  for (const handle of openHandles.splice(0)) {
    try {
      handle.db.close();
    } catch {
      // already closed by the test itself
    }
    rmSync(handle.dir, { recursive: true, force: true });
  }
});

describe("standalone conversation persistence", () => {
  it("survives database reopen after activation and recent lists it first", () => {
    const { dir, path, db } = openTestDb();
    const repos = createRepositories(db);

    const blank = repos.conversations.create();
    expect(blank.title).toBe("新对话");
    expect(blank.hasUserMessage).toBe(false);
    expect(repos.conversations.listRecent()).toEqual([]);

    repos.messages.append(blank.id, "user", "第一条");
    const activated = repos.conversations.activate(blank.id, "第一条");
    expect(activated.id).toBe(blank.id);
    expect(activated.title).toBe("第一条");
    expect(activated.hasUserMessage).toBe(true);
    expect(repos.conversations.listRecent().map((conversation) => conversation.id)).toEqual([
      blank.id,
    ]);
    db.close();

    const reopened = openDatabase(path);
    openHandles.push({ dir, path, db: reopened });
    migrate(reopened);
    const reposAfterRestart = createRepositories(reopened);

    const recent = reposAfterRestart.conversations.listRecent();
    expect(recent.map((conversation) => conversation.id)).toEqual([blank.id]);
    expect(recent[0]!.title).toBe("第一条");

    const messages = reposAfterRestart.messages.listByConversation(blank.id);
    expect(messages.map((message) => message.role)).toEqual(["user"]);
    expect(messages.map((message) => message.content)).toEqual(["第一条"]);
  });

  it("reuses the newest blank draft and creates only one row on repeated calls", () => {
    const { db } = openTestDb();
    const repos = createRepositories(db);

    const first = repos.conversations.getOrCreateDraft();
    const second = repos.conversations.getOrCreateDraft();

    expect(second.id).toBe(first.id);
    expect(second.title).toBe("新对话");
    const row = db
      .prepare("SELECT count(*) AS n FROM conversations")
      .get() as unknown as { n: number };
    expect(row.n).toBe(1);
  });

  it("keeps messages in creation order after close and reopen with migrate", () => {
    const { dir, path, db } = openTestDb();
    const repos = createRepositories(db);

    const conversation = repos.conversations.create();
    repos.messages.append(conversation.id, "user", "第一条");
    repos.messages.append(conversation.id, "assistant", "第二条");
    db.close();

    const reopened = openDatabase(path);
    openHandles.push({ dir, path, db: reopened });
    migrate(reopened);
    const reposAfterRestart = createRepositories(reopened);

    const messages = reposAfterRestart.messages.listByConversation(conversation.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages.map((message) => message.content)).toEqual(["第一条", "第二条"]);
  });

  it("returns the newest N messages in chronological order", () => {
    const { db } = openTestDb();
    const repos = createRepositories(db);

    const conversation = repos.conversations.create();
    repos.messages.append(conversation.id, "user", "m1");
    repos.messages.append(conversation.id, "assistant", "m2");
    repos.messages.append(conversation.id, "user", "m3");
    repos.messages.append(conversation.id, "assistant", "m4");

    const latestTwo = repos.messages.listByConversation(conversation.id, 2);
    expect(latestTwo.map((message) => message.content)).toEqual(["m3", "m4"]);
    expect(latestTwo.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("rejects non-positive or non-integer limits", () => {
    const { db } = openTestDb();
    const repos = createRepositories(db);

    const conversation = repos.conversations.create();

    expect(() => repos.messages.listByConversation(conversation.id, 0)).toThrow(/positive integer/);
    expect(() => repos.messages.listByConversation(conversation.id, -3)).toThrow(/positive integer/);
    expect(() => repos.messages.listByConversation(conversation.id, 2.5)).toThrow(/positive integer/);
  });

  it("hides blank drafts from recent until activated", () => {
    const { db } = openTestDb();
    const repos = createRepositories(db);

    const conversation = repos.conversations.create();
    expect(repos.conversations.listRecent()).toEqual([]);

    repos.messages.append(conversation.id, "user", "你好");
    const activated = repos.conversations.activate(conversation.id, "你好");

    const recent = repos.conversations.listRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe(conversation.id);
    expect(recent[0]!.title).toBe(activated.title);
  });

  it("enforces foreign keys and cascades deletes to children", () => {
    const { db } = openTestDb();
    const repos = createRepositories(db);

    const conversation = repos.conversations.create();
    repos.messages.append(conversation.id, "user", "你好");

    expect(() =>
      repos.messages.append("no-such-conversation" as ConversationId, "user", "孤儿消息"),
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.prepare("DELETE FROM conversations WHERE id = ?").run(conversation.id);

    expect(repos.messages.listByConversation(conversation.id)).toEqual([]);
    expect(repos.conversations.getById(conversation.id)).toBeUndefined();
  });

  it("keeps every test database isolated", () => {
    const a = openTestDb();
    const b = openTestDb();
    const reposA = createRepositories(a.db);
    createRepositories(b.db);
    reposA.conversations.create();

    const row = b.db
      .prepare("SELECT count(*) AS n FROM conversations")
      .get() as unknown as { n: number };
    expect(row.n).toBe(0);
  });
});
