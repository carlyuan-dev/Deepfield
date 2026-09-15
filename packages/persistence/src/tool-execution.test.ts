import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import type { Repositories, ToolExecutionStart } from "@deepfield/persistence";
import { ToolExecutionError } from "./tool-execution-repository.js";

const ISO = "2026-01-01T00:00:00.000Z";

function openRaw(): { db: DatabaseSync; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "df-tool-exec-"));
  const db = openDatabase(join(dir, "t.sqlite"));
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function openTemp(): { db: DatabaseSync; repos: Repositories; cleanup(): void } {
  const raw = openRaw();
  migrate(raw.db);
  return { db: raw.db, repos: createRepositories(raw.db), cleanup: raw.cleanup };
}

function start(
  repos: Repositories,
  id: string,
  overrides: Partial<ToolExecutionStart> = {},
): void {
  repos.toolExecutions.start({
    id,
    traceId: "trace-1",
    actor: "developer_probe",
    toolName: "echo",
    toolVersion: 1,
    startedAt: ISO,
    ...overrides,
  });
}

function finish(
  repos: Repositories,
  id: string,
  overrides: Record<string, unknown> = {},
): void {
  const base = {
    id,
    status: "completed",
    attempts: 1,
    retries: 0,
    bytesReceived: 0,
    resultCount: 0,
    finishedAt: ISO,
  };
  repos.toolExecutions.finish({
    ...base,
    ...(overrides as Record<string, unknown>),
  } as unknown as Parameters<Repositories["toolExecutions"]["finish"]>[0]);
}

describe("migration 2", () => {
  it("creates tool_executions with the planned shape and indexes, recorded exactly once", () => {
    const { db, cleanup } = openRaw();
    migrate(db);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_executions'")
      .get();
    expect(table).toBeDefined();
    const columns = db
      .prepare("PRAGMA table_info(tool_executions)")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "trace_id",
      "project_id",
      "actor",
      "tool_name",
      "tool_version",
      "status",
      "agent_turn_index",
      "batch_id",
      "tool_call_id",
      "budget_consumed",
      "input_summary_json",
      "output_summary_json",
      "error_code",
      "attempts",
      "retries",
      "bytes_received",
      "result_count",
      "started_at",
      "finished_at",
      "duration_ms",
    ]);
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_executions' AND name NOT LIKE 'sqlite_autoindex_%'",
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name).sort()).toEqual([
      "idx_tool_executions_project_id",
      "idx_tool_executions_started_at_id",
      "idx_tool_executions_trace_id",
    ]);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=2").get() as {
        n: number;
      }).n,
    ).toBe(1);
    migrate(db);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=2").get() as {
        n: number;
      }).n,
    ).toBe(1);
    cleanup();
  });
  it("upgrades a P1-version database without losing conversation storage", () => {
    const { db, cleanup } = openRaw();
    migrate(db);
    db.exec("DROP TABLE tool_executions;");
    db.exec("DELETE FROM schema_migrations WHERE version = 2;");
    migrate(db);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_executions'")
        .get(),
    ).toBeDefined();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get(),
    ).toBeDefined();
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=2").get() as {
        n: number;
      }).n,
    ).toBe(1);
    cleanup();
  });
  it("rolls back the table, indexes and version record when migration 2 fails", () => {
    const { db, cleanup } = openRaw();
    migrate(db);
    db.exec("DROP TABLE tool_executions;");
    db.exec("DELETE FROM schema_migrations WHERE version = 2;");
    db.exec("CREATE TABLE blocker(id TEXT);");
    db.exec("CREATE INDEX idx_tool_executions_trace_id ON blocker(id);");
    expect(() => migrate(db)).toThrow();
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tool_executions'")
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tool_executions'")
        .all(),
    ).toEqual([]);
    expect(
      db.prepare("SELECT version FROM schema_migrations WHERE version=2").get(),
    ).toBeUndefined();
    cleanup();
  });
});

describe("migration 10", () => {
  it("preserves legacy executions with unknown consumption while adding batch scope", () => {
    const { db, cleanup } = openRaw();
    migrate(db);
    db.prepare(
      "INSERT INTO tool_executions(id, trace_id, actor, tool_name, tool_version, status, attempts, retries, bytes_received, result_count, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "legacy-exec",
      "legacy-trace",
      "main_agent",
      "web_search",
      1,
      "completed",
      1,
      0,
      0,
      0,
      ISO,
      ISO,
    );
    db.exec(`
      CREATE TABLE tool_executions_v9(
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        project_id TEXT,
        actor TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
        input_summary_json TEXT,
        output_summary_json TEXT,
        error_code TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        bytes_received INTEGER NOT NULL DEFAULT 0,
        result_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER
      );
      INSERT INTO tool_executions_v9(
        id, trace_id, project_id, actor, tool_name, tool_version, status,
        input_summary_json, output_summary_json, error_code, attempts, retries,
        bytes_received, result_count, started_at, finished_at, duration_ms
      )
      SELECT
        id, trace_id, project_id, actor, tool_name, tool_version, status,
        input_summary_json, output_summary_json, error_code, attempts, retries,
        bytes_received, result_count, started_at, finished_at, duration_ms
      FROM tool_executions;
      DROP TABLE tool_executions;
      ALTER TABLE tool_executions_v9 RENAME TO tool_executions;
      DROP TABLE company_research_model_diagnostics;
      DELETE FROM schema_migrations WHERE version >= 10;
    `);

    migrate(db);

    const row = db.prepare(
      "SELECT trace_id, agent_turn_index, batch_id, tool_call_id, budget_consumed FROM tool_executions WHERE id = ?",
    ).get("legacy-exec") as Record<string, unknown>;
    expect(row).toEqual({
      trace_id: "legacy-trace",
      agent_turn_index: null,
      batch_id: null,
      tool_call_id: null,
      budget_consumed: null,
    });
    expect(createRepositories(db).toolExecutions.getById("legacy-exec")).not.toHaveProperty(
      "budgetConsumed",
    );
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=10").get() as {
        n: number;
      }).n,
    ).toBe(1);
    cleanup();
  });
});

describe("migration 11", () => {
  it("recovers unknown consumption from a previously migrated unscoped zero", () => {
    const { db, cleanup } = openRaw();
    migrate(db);
    db.prepare(
      "INSERT INTO tool_executions(id, trace_id, actor, tool_name, tool_version, status, budget_consumed, error_code, attempts, retries, bytes_received, result_count, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "v10-timeout",
      "legacy-trace",
      "main_agent",
      "web_search",
      1,
      "failed",
      0,
      "timeout",
      1,
      0,
      0,
      0,
      ISO,
      ISO,
    );
    db.exec("DELETE FROM schema_migrations WHERE version = 11;");

    migrate(db);

    expect(db.prepare(
      "SELECT budget_consumed FROM tool_executions WHERE id = 'v10-timeout'",
    ).get()).toEqual({ budget_consumed: null });
    expect(createRepositories(db).toolExecutions.getById("v10-timeout")).not.toHaveProperty(
      "budgetConsumed",
    );
    cleanup();
  });
});

describe("tool execution repository", () => {
  it("starts a running record atomically and rejects duplicate ids", () => {
    const { repos, cleanup } = openTemp();
    start(repos, "exec-1");
    expect(repos.toolExecutions.getById("exec-1")).toMatchObject({
      id: "exec-1",
      traceId: "trace-1",
      actor: "developer_probe",
      toolName: "echo",
      toolVersion: 1,
      status: "running",
      attempts: 0,
    });
    expect(() => start(repos, "exec-1")).toThrow(ToolExecutionError);
    cleanup();
  });
  it("records skipped and reused calls as terminal non-executions with their batch scope", () => {
    const { repos, cleanup } = openTemp();
    repos.toolExecutions.recordSynthetic({
      id: "skip-1",
      traceId: "req-1",
      actor: "main_agent",
      toolName: "web_search",
      toolVersion: 1,
      status: "skipped",
      errorCode: "budget_trimmed",
      agentTurnIndex: 2,
      batchId: "batch-2",
      toolCallId: "call-5",
      attempts: 0,
      budgetConsumed: false,
      startedAt: ISO,
      finishedAt: ISO,
    });
    repos.toolExecutions.recordSynthetic({
      id: "reuse-1",
      traceId: "req-1",
      actor: "main_agent",
      toolName: "web_search",
      toolVersion: 1,
      status: "reused",
      agentTurnIndex: 2,
      batchId: "batch-2",
      toolCallId: "call-6",
      attempts: 0,
      budgetConsumed: false,
      startedAt: ISO,
      finishedAt: ISO,
    });

    expect(repos.toolExecutions.listRecent(10)).toMatchObject([
      {
        id: "skip-1",
        status: "skipped",
        errorCode: "budget_trimmed",
        agentTurnIndex: 2,
        batchId: "batch-2",
        toolCallId: "call-5",
        attempts: 0,
        budgetConsumed: false,
        finishedAt: ISO,
      },
      {
        id: "reuse-1",
        status: "reused",
        agentTurnIndex: 2,
        batchId: "batch-2",
        toolCallId: "call-6",
        attempts: 0,
        budgetConsumed: false,
        finishedAt: ISO,
      },
    ]);
    cleanup();
  });

  it("rejects synthetic records that imply execution or use contradictory reason codes", () => {
    const { repos, cleanup } = openTemp();
    const base = {
      id: "synthetic-bad",
      traceId: "req-1",
      actor: "main_agent",
      toolName: "web_search",
      toolVersion: 1,
      status: "skipped",
      errorCode: "budget_trimmed",
      agentTurnIndex: 1,
      batchId: "batch-1",
      toolCallId: "call-1",
      attempts: 0,
      budgetConsumed: false,
      startedAt: ISO,
      finishedAt: ISO,
    } as const;
    expect(() => repos.toolExecutions.recordSynthetic({ ...base, attempts: 1 } as never)).toThrow(
      ToolExecutionError,
    );
    expect(() =>
      repos.toolExecutions.recordSynthetic({ ...base, budgetConsumed: true } as never),
    ).toThrow(ToolExecutionError);
    expect(() =>
      repos.toolExecutions.recordSynthetic({ ...base, errorCode: "timeout" } as never),
    ).toThrow(ToolExecutionError);
    expect(() =>
      repos.toolExecutions.recordSynthetic({
        ...base,
        status: "failed",
        errorCode: "timeout",
      } as never),
    ).toThrow(ToolExecutionError);
    expect(repos.toolExecutions.getById(base.id)).toBeUndefined();
    cleanup();
  });

  it("persists a Pi pre-dispatch validation failure as non-consumed synthetic activity", () => {
    const { repos, cleanup } = openTemp();
    repos.toolExecutions.recordSynthetic({
      id: "invalid-call-key",
      traceId: "req-1",
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
      startedAt: ISO,
      finishedAt: ISO,
    });

    expect(repos.toolExecutions.getById("invalid-call-key")).toMatchObject({
      id: "invalid-call-key",
      status: "failed",
      errorCode: "invalid_input",
      toolCallId: "invalid-first",
      attempts: 0,
      budgetConsumed: false,
    });
    cleanup();
  });

  it("rejects a corrupted zero-attempt row that claims consumed budget", () => {
    const { db, repos, cleanup } = openTemp();
    start(repos, "corrupt-zero-attempt");
    repos.toolExecutions.finish({
      id: "corrupt-zero-attempt",
      status: "failed",
      errorCode: "timeout",
      attempts: 0,
      retries: 0,
      bytesReceived: 0,
      resultCount: 0,
      budgetConsumed: false,
      finishedAt: ISO,
    });
    expect(repos.toolExecutions.getById("corrupt-zero-attempt")).toMatchObject({
      status: "failed",
      attempts: 0,
      budgetConsumed: false,
      errorCode: "timeout",
    });

    db.prepare(
      "UPDATE tool_executions SET budget_consumed = 1 WHERE id = ?",
    ).run("corrupt-zero-attempt");

    expect(() => repos.toolExecutions.getById("corrupt-zero-attempt")).toThrow(
      "stored tool execution data is invalid",
    );
    cleanup();
  });
  it("finishes a running execution and survives a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "df-tool-reopen-"));
    const path = join(dir, "t.sqlite");
    let db = openDatabase(path);
    migrate(db);
    let repos = createRepositories(db);
    start(repos, "exec-1");
    repos.toolExecutions.finish({
      id: "exec-1",
      status: "completed",
      attempts: 2,
      retries: 1,
      bytesReceived: 10,
      resultCount: 3,
      finishedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
    });
    db.close();
    db = openDatabase(path);
    migrate(db);
    repos = createRepositories(db);
    expect(repos.toolExecutions.getById("exec-1")).toMatchObject({
      status: "completed",
      attempts: 2,
      retries: 1,
      bytesReceived: 10,
      resultCount: 3,
      durationMs: 1000,
      finishedAt: "2026-01-01T00:00:01.000Z",
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("fails on unknown id and on double finish with distinct errors", () => {
    const { repos, cleanup } = openTemp();
    expect(() => finish(repos, "missing")).toThrowError("not found");
    start(repos, "exec-1");
    finish(repos, "exec-1");
    let message = "";
    try {
      finish(repos, "exec-1", { status: "failed", errorCode: "executor_failed" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("already finished");
    expect(repos.toolExecutions.getById("exec-1")?.status).toBe("completed");
    cleanup();
  });
  it("lists recent executions newest-first with a deterministic tie-break", () => {
    const { repos, cleanup } = openTemp();
    start(repos, "a", { startedAt: "2026-01-01T00:00:00.000Z" });
    start(repos, "b", { startedAt: "2026-01-02T00:00:00.000Z" });
    start(repos, "c", { startedAt: "2026-01-02T00:00:00.000Z" });
    start(repos, "d", { startedAt: "2026-01-03T00:00:00.000Z" });
    expect(repos.toolExecutions.listRecent(2).map((r) => r.id)).toEqual(["d", "c"]);
    expect(repos.toolExecutions.listRecent(3).map((r) => r.id)).toEqual(["d", "c", "b"]);
    expect(() => repos.toolExecutions.listRecent(0)).toThrow();
    expect(() => repos.toolExecutions.listRecent(-1)).toThrow();
    expect(() => repos.toolExecutions.listRecent(NaN)).toThrow();
    expect(() => repos.toolExecutions.listRecent(1.5)).toThrow();
    cleanup();
  });
  it("validates every external field and persists nothing invalid", () => {
    const { repos, cleanup } = openTemp();
    const badStarts: Partial<ToolExecutionStart>[] = [
      { id: "" },
      { traceId: "" },
      { actor: "" },
      { toolName: "" },
      { toolVersion: 0 },
      { toolVersion: 1.5 },
      { toolVersion: NaN },
      { startedAt: "not-a-date" },
      { projectId: "" },
    ];
    for (const bad of badStarts) {
      expect(() => start(repos, "x", bad)).toThrow();
    }
    const badFinishes: Record<string, unknown>[] = [
      { status: "running" },
      { status: "bogus" },
      { attempts: -1 },
      { attempts: 1.5 },
      { attempts: NaN },
      { retries: -1 },
      { bytesReceived: -1 },
      { resultCount: Infinity },
      { durationMs: -5 },
      { finishedAt: "bad" },
    ];
    for (const bad of badFinishes) {
      expect(() => finish(repos, "x", bad)).toThrow();
    }
    expect(repos.toolExecutions.getById("x")).toBeUndefined();
    cleanup();
  });
  it("returns fresh objects and raises safe errors on corrupt JSON", () => {
    const { db, repos, cleanup } = openTemp();
    start(repos, "exec-1");
    const first = repos.toolExecutions.getById("exec-1")!;
    (first as { traceId: string }).traceId = "mutated";
    expect(repos.toolExecutions.getById("exec-1")!.traceId).toBe("trace-1");
    db.exec("UPDATE tool_executions SET input_summary_json = '{broken' WHERE id='exec-1'");
    expect(() => repos.toolExecutions.getById("exec-1")).toThrow(ToolExecutionError);
    let message = "";
    try {
      repos.toolExecutions.getById("exec-1");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("broken");
    cleanup();
  });
});
