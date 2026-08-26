import { afterEach, describe, expect, it } from "vitest";
import type { ProjectId, ProjectScope } from "@deepfield/contracts";
import {
  buildSystemPrompt,
  canonicalScopeJson,
  ContextBuilder,
  ContextBuilderError,
} from "./context-builder.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

function makeProject(db: TestDb, scope: ProjectScope = {}, industry = "人形机器人") {
  const project = db.repos.projects.createWithConversation({
    industry,
    scope,
    launchSource: "direct-ui",
  });
  const conversation = db.repos.conversations.listByProject(project.id)[0]!;
  return { project, conversation };
}

describe("context builder", () => {
  it("builds the exact system prompt", () => {
    const db = openTestDb();
    dbs.push(db);
    const builder = new ContextBuilder(db.repos);
    const { project } = makeProject(db, { focus: "整机与核心零部件" });

    const snapshot = builder.build(project.id);
    expect(snapshot.systemPrompt).toBe(
      [
        "你是 Deepfield 的主 Agent。",
        "当前项目：人形机器人",
        "项目范围：{\"focus\":\"整机与核心零部件\"}",
        "你当前处于普通 Chat，不得声称已经联网搜索或执行行业研究。",
        "需要持久化行业研究时，应建议用户进入“行业研究” Capability。",
      ].join("\n"),
    );
    expect(buildSystemPrompt("人形机器人", { focus: "整机" })).toBe(
      [
        "你是 Deepfield 的主 Agent。",
        "当前项目：人形机器人",
        "项目范围：{\"focus\":\"整机\"}",
        "你当前处于普通 Chat，不得声称已经联网搜索或执行行业研究。",
        "需要持久化行业研究时，应建议用户进入“行业研究” Capability。",
      ].join("\n"),
    );
  });

  it("serializes scope in fixed key order and omits undefined values", () => {
    const a: ProjectScope = { focus: "整机", exclusions: ["工业机械臂"] };
    const b: ProjectScope = { exclusions: ["工业机械臂"], focus: "整机" };
    expect(canonicalScopeJson(a)).toBe('{"focus":"整机","exclusions":["工业机械臂"]}');
    expect(canonicalScopeJson(a)).toBe(canonicalScopeJson(b));

    const partial: ProjectScope = { timeRange: "2026" };
    expect(canonicalScopeJson(partial)).toBe('{"timeRange":"2026"}');

    const full: ProjectScope = {
      focus: "f",
      geography: "g",
      timeRange: "t",
      exclusions: ["e"],
      customRequirements: ["c"],
    };
    expect(canonicalScopeJson(full)).toBe(
      '{"focus":"f","geography":"g","timeRange":"t","exclusions":["e"],"customRequirements":["c"]}',
    );
  });

  it("returns the latest 40 messages in chronological order", () => {
    const db = openTestDb();
    dbs.push(db);
    const builder = new ContextBuilder(db.repos);
    const { project, conversation } = makeProject(db);
    for (let index = 0; index < 45; index += 1) {
      db.repos.messages.append(conversation.id, index % 2 === 0 ? "user" : "assistant", `m${index}`);
    }

    const snapshot = builder.build(project.id);
    expect(snapshot.messages).toHaveLength(40);
    expect(snapshot.messages[0]!.content).toBe("m5");
    expect(snapshot.messages[39]!.content).toBe("m44");
    expect(snapshot.messages[0]!.timestamp).toBeTypeOf("number");
  });

  it("excludes the current user message by id while keeping 40", () => {
    const db = openTestDb();
    dbs.push(db);
    const builder = new ContextBuilder(db.repos);
    const { project, conversation } = makeProject(db);
    for (let index = 0; index < 45; index += 1) {
      db.repos.messages.append(conversation.id, index % 2 === 0 ? "user" : "assistant", `m${index}`);
    }
    const all = db.repos.messages.listByConversation(conversation.id);
    const current = all[44]!;

    const snapshot = builder.build(project.id, { excludeMessageId: current.id });
    expect(snapshot.messages).toHaveLength(40);
    expect(snapshot.messages.some((message) => message.content === "m44")).toBe(false);
    expect(snapshot.messages[39]!.content).toBe("m43");
  });

  it("fails safely when the project or conversation is missing and never injects activity", () => {
    const db = openTestDb();
    dbs.push(db);
    const builder = new ContextBuilder(db.repos);

    expect(() => builder.build("missing-project" as ProjectId)).toThrow(ContextBuilderError);

    db.db
      .prepare(
        "INSERT INTO projects(id, industry, scope_json, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)",
      )
      .run("orphan", "孤儿项目", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    expect(() => builder.build("orphan" as ProjectId)).toThrow(/conversation/);

    const row = db.db
      .prepare("SELECT count(*) AS n FROM project_activity_events")
      .get() as unknown as { n: number };
    expect(row.n).toBe(0);
  });
});
