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

describe("project persistence", () => {
  it("creates a project with one silent activity and no Conversation", () => {
    const { db } = openTestDb();
    const repos = createRepositories(db);

    const project = repos.projects.create({
      industry: "人形机器人",
      scope: { focus: "整机与核心零部件" },
      launchSource: "direct-ui",
    });

    expect(project.industry).toBe("人形机器人");
    expect(project.scope).toEqual({ focus: "整机与核心零部件" });
    expect(project.status).toBe("draft");

    const conversationCount = db
      .prepare("SELECT count(*) AS n FROM conversations")
      .get() as unknown as { n: number };
    expect(conversationCount.n).toBe(0);

    const activities = repos.activities.listByProject(project.id);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      type: "project.created",
      source: "direct-ui",
      importance: "silent",
      summary: "创建项目：人形机器人",
    });

    expect(repos.conversations.listRecent()).toEqual([]);
  });

  it("applies all migrations once and leaves conversations without a project column", () => {
    const { db } = openTestDb();
    migrate(db);
    migrate(db);

    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as unknown as Array<{ version: number }>;
    expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);

    for (const table of [
      "projects",
      "conversations",
      "messages",
      "project_activity_events",
      "tool_executions",
    ]) {
      const row = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as unknown as { n: number };
      expect(row.n).toBe(1);
    }

    const conversationColumns = db
      .prepare("PRAGMA table_info(conversations)")
      .all() as unknown as Array<{ name: string }>;
    const names = conversationColumns.map((column) => column.name);
    expect(names).not.toContain("project_id");
    expect(names).toEqual(
      expect.arrayContaining(["id", "title", "has_user_message", "created_at", "updated_at"]),
    );
  });

  it("rolls back the migration tracking table when migration 001 fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepfield-db-"));
    const path = join(dir, "deepfield.sqlite");
    const db = openDatabase(path);
    openHandles.push({ dir, path, db });
    db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY);");

    expect(() => migrate(db)).toThrow(/already exists/);

    const tracking = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .all();
    expect(tracking).toEqual([]);
  });
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

  it("rolls back the whole project creation when the activity insert fails", () => {
    const { db } = openTestDb();
    db.exec(`
      CREATE TRIGGER fail_activity_insert
      BEFORE INSERT ON project_activity_events
      BEGIN
        SELECT RAISE(ABORT, 'forced activity insert failure');
      END;
    `);
    const repos = createRepositories(db);

    expect(() =>
      repos.projects.create({
        industry: "人形机器人",
        scope: {},
        launchSource: "direct-ui",
      }),
    ).toThrow(/forced activity insert failure/);

    const count = (table: string): number =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as unknown as { n: number }).n;
    expect(count("projects")).toBe(0);
    expect(count("project_activity_events")).toBe(0);
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

    reposA.projects.create({
      industry: "人形机器人",
      scope: {},
      launchSource: "chat",
    });

    const row = b.db
      .prepare("SELECT count(*) AS n FROM projects")
      .get() as unknown as { n: number };
    expect(row.n).toBe(0);
  });
});
