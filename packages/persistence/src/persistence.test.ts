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
  it("creates one project conversation and one silent activity atomically", () => {
    const { db } = openTestDb();
    const repos = createRepositories(db);

    const project = repos.projects.createWithConversation({
      industry: "人形机器人",
      scope: { focus: "整机与核心零部件" },
      launchSource: "direct-ui",
    });

    expect(project.industry).toBe("人形机器人");
    expect(project.scope).toEqual({ focus: "整机与核心零部件" });
    expect(project.status).toBe("draft");

    const conversations = repos.conversations.listByProject(project.id);
    expect(conversations).toHaveLength(1);
    const conversation = conversations[0]!;
    expect(conversation.hasUserMessage).toBe(false);

    const activities = repos.activities.listByProject(project.id);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      type: "project.created",
      source: "direct-ui",
      importance: "silent",
      summary: "创建项目：人形机器人",
    });

    expect(repos.messages.listByConversation(conversation.id)).toEqual([]);
    expect(repos.conversations.listRecent()).toEqual([]);
  });

  it("applies migration 001 only once across repeated migrate calls", () => {
    const { db } = openTestDb();
    migrate(db);
    migrate(db);

    const versions = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as unknown as Array<{ version: number }>;
    expect(versions).toEqual([{ version: 1 }, { version: 2 }]);

    for (const table of ["projects", "conversations", "messages", "project_activity_events"]) {
      const row = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as unknown as { n: number };
      expect(row.n).toBe(1);
    }
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

  it("returns the same conversation id on repeated getOrCreate calls", () => {
    const { db } = openTestDb();
    const repos = createRepositories(db);

    const project = repos.projects.createWithConversation({
      industry: "人形机器人",
      scope: {},
      launchSource: "chat",
    });

    const first = repos.conversations.getOrCreateForProject(project.id);
    const second = repos.conversations.getOrCreateForProject(project.id);

    expect(second.id).toBe(first.id);
    const row = db
      .prepare("SELECT count(*) AS n FROM conversations WHERE project_id = ?")
      .get(project.id) as unknown as { n: number };
    expect(row.n).toBe(1);
  });

  it("keeps messages in creation order after close and reopen with migrate", () => {
    const { dir, path, db } = openTestDb();
    const repos = createRepositories(db);

    const project = repos.projects.createWithConversation({
      industry: "人形机器人",
      scope: {},
      launchSource: "chat",
    });
    const conversation = repos.conversations.getOrCreateForProject(project.id);
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

    const project = repos.projects.createWithConversation({
      industry: "人形机器人",
      scope: {},
      launchSource: "chat",
    });
    const conversation = repos.conversations.getOrCreateForProject(project.id);
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

    const project = repos.projects.createWithConversation({
      industry: "人形机器人",
      scope: {},
      launchSource: "chat",
    });
    const conversation = repos.conversations.getOrCreateForProject(project.id);

    expect(() => repos.messages.listByConversation(conversation.id, 0)).toThrow(/positive integer/);
    expect(() => repos.messages.listByConversation(conversation.id, -3)).toThrow(/positive integer/);
    expect(() => repos.messages.listByConversation(conversation.id, 2.5)).toThrow(/positive integer/);
  });

  it("rolls back the whole creation when the conversation insert fails", () => {
    const { db } = openTestDb();
    db.exec(`
      CREATE TRIGGER fail_conversation_insert
      BEFORE INSERT ON conversations
      BEGIN
        SELECT RAISE(ABORT, 'forced conversation insert failure');
      END;
    `);
    const repos = createRepositories(db);

    expect(() =>
      repos.projects.createWithConversation({
        industry: "人形机器人",
        scope: {},
        launchSource: "direct-ui",
      }),
    ).toThrow(/forced conversation insert failure/);

    const count = (table: string): number =>
      (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as unknown as { n: number }).n;
    expect(count("projects")).toBe(0);
    expect(count("conversations")).toBe(0);
    expect(count("messages")).toBe(0);
    expect(count("project_activity_events")).toBe(0);
  });

  it("hides conversations from recent until they have a user message", () => {
    const { db } = openTestDb();
    const repos = createRepositories(db);

    const project = repos.projects.createWithConversation({
      industry: "人形机器人",
      scope: {},
      launchSource: "chat",
    });
    expect(repos.conversations.listRecent()).toEqual([]);

    const conversation = repos.conversations.getOrCreateForProject(project.id);
    repos.conversations.markHasUserMessage(conversation.id);

    const recent = repos.conversations.listRecent();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe(conversation.id);
  });

  it("enforces foreign keys and cascades deletes to children", () => {
    const { db } = openTestDb();
    const repos = createRepositories(db);

    const project = repos.projects.createWithConversation({
      industry: "人形机器人",
      scope: {},
      launchSource: "chat",
    });
    const conversation = repos.conversations.getOrCreateForProject(project.id);
    repos.messages.append(conversation.id, "user", "你好");
    repos.activities.append(project.id, "chat.message.completed", "chat", "normal", "回复完成", {
      ok: true,
    });

    expect(() =>
      repos.messages.append("no-such-conversation" as ConversationId, "user", "孤儿消息"),
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);

    expect(repos.conversations.listByProject(project.id)).toEqual([]);
    expect(repos.messages.listByConversation(conversation.id)).toEqual([]);
    expect(repos.activities.listByProject(project.id)).toEqual([]);
  });

  it("keeps every test database isolated", () => {
    const a = openTestDb();
    const b = openTestDb();
    const reposA = createRepositories(a.db);
    createRepositories(b.db);

    reposA.projects.createWithConversation({
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
