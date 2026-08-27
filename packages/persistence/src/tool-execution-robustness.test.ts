import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createRepositories, migrate, openDatabase, ToolExecutionError } from "@deepfield/persistence";
import type { Repositories, ToolExecutionStart } from "@deepfield/persistence";

const ISO = "2026-01-01T00:00:00.000Z";

function openRaw(): { db: DatabaseSync; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "df-tool-robust-"));
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

function finish(repos: Repositories, id: string, overrides: Record<string, unknown> = {}): void {
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

describe("tool execution robustness (focused revision)", () => {
  it("rejects non-existent dates and non-canonical formats on start and finish", () => {
    const { repos, cleanup } = openTemp();
    const badDates = [
      "2026-99-99T00:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      "2026-02-29T00:00:00.000Z",
      "2026-13-01T00:00:00.000Z",
      "2026-01-01T25:00:00.000Z",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00.000+08:00",
      "2026-01-01T00:00:00.000",
    ];
    for (const bad of badDates) {
      expect(() => start(repos, "x", { startedAt: bad })).toThrow();
      expect(() => finish(repos, "x", { finishedAt: bad })).toThrow();
    }
    start(repos, "leap", { startedAt: "2024-02-29T00:00:00.000Z" });
    expect(repos.toolExecutions.getById("leap")?.status).toBe("running");
    cleanup();
  });

  it("maps finish database exceptions to a safe persistence error without half-updates", () => {
    const { db, repos, cleanup } = openTemp();
    start(repos, "exec-1");
    db.exec(
      "CREATE TRIGGER boom BEFORE UPDATE ON tool_executions BEGIN SELECT RAISE(ABORT, 'secret raw sqlite failure'); END;",
    );
    let error: unknown;
    try {
      finish(repos, "exec-1");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ToolExecutionError);
    if (error instanceof ToolExecutionError) {
      expect(error.code).toBe("persistence");
      expect(error.message).not.toContain("secret");
      expect(error.message).not.toContain("sqlite");
      expect(error.message).not.toContain("RAISE");
    }
    expect(JSON.stringify({ error: String(error) })).not.toContain("secret raw sqlite failure");
    expect(repos.toolExecutions.getById("exec-1")?.status).toBe("running");
    const row = db
      .prepare("SELECT attempts, finished_at FROM tool_executions WHERE id='exec-1'")
      .get() as { attempts: number; finished_at: string | null };
    expect(row.attempts).toBe(0);
    expect(row.finished_at).toBeNull();
    cleanup();
  });

  it("rejects unknown failure codes on write and persists nothing", () => {
    const { db, repos, cleanup } = openTemp();
    start(repos, "exec-1");
    expect(() =>
      finish(repos, "exec-1", { status: "failed", errorCode: "sk-secret-provider-value" }),
    ).toThrow(ToolExecutionError);
    const row = db
      .prepare("SELECT status, error_code FROM tool_executions WHERE id='exec-1'")
      .get() as { status: string; error_code: string | null };
    expect(row.status).toBe("running");
    expect(row.error_code).toBeNull();
    cleanup();
  });

  it("rejects contradictory status and errorCode combinations on finish", () => {
    const { repos, cleanup } = openTemp();
    start(repos, "comp");
    expect(() => finish(repos, "comp", { status: "completed", errorCode: "timeout" })).toThrow(
      ToolExecutionError,
    );
    start(repos, "fail-no-code");
    expect(() => finish(repos, "fail-no-code", { status: "failed" })).toThrow(ToolExecutionError);
    expect(repos.toolExecutions.getById("comp")?.status).toBe("running");
    expect(repos.toolExecutions.getById("fail-no-code")?.status).toBe("running");
    const rows = repos.toolExecutions.listRecent(10);
    expect(rows.every((row) => row.status === "running" && row.errorCode === undefined)).toBe(true);
    start(repos, "ok-fail");
    finish(repos, "ok-fail", { status: "failed", errorCode: "executor_failed" });
    expect(repos.toolExecutions.getById("ok-fail")?.status).toBe("failed");
    expect(repos.toolExecutions.getById("ok-fail")?.errorCode).toBe("executor_failed");
    start(repos, "ok-cancel");
    finish(repos, "ok-cancel", { status: "cancelled" });
    expect(repos.toolExecutions.getById("ok-cancel")?.status).toBe("cancelled");
    cleanup();
  });

  it("fails closed on corrupted rows for both getById and listRecent", () => {
    const { db, repos, cleanup } = openTemp();
    const corruptions: { name: string; sql: string }[] = [
      { name: "negative attempts", sql: "UPDATE tool_executions SET attempts = -1" },
      { name: "fractional retries", sql: "UPDATE tool_executions SET retries = 1.5" },
      { name: "non-canonical date", sql: "UPDATE tool_executions SET started_at = '2026-99-99T00:00:00.000Z'" },
      { name: "running with finished_at", sql: "UPDATE tool_executions SET finished_at = '2026-01-01T00:00:00.000Z'" },
      { name: "terminal with null finished_at", sql: "UPDATE tool_executions SET status = 'completed', finished_at = NULL" },
      { name: "forbidden summary", sql: "UPDATE tool_executions SET input_summary_json = '{\"body\":\"secret\"}'" },
      { name: "corrupt summary json", sql: "UPDATE tool_executions SET input_summary_json = '{broken'" },
      { name: "unknown error code", sql: "UPDATE tool_executions SET error_code = 'sk-secret-provider-value'" },
      { name: "running with error_code", sql: "UPDATE tool_executions SET error_code = 'timeout'" },
      { name: "completed with error_code", sql: "UPDATE tool_executions SET status = 'completed', finished_at = '2026-01-01T00:00:01.000Z', error_code = 'timeout'" },
      { name: "failed without error_code", sql: "UPDATE tool_executions SET status = 'failed', finished_at = '2026-01-01T00:00:01.000Z', error_code = NULL" },
    ];
    corruptions.forEach((corruption, i) => {
      start(repos, `c${i}`);
      db.exec(`${corruption.sql} WHERE id='c${i}'`);
      let getError: unknown;
      try {
        repos.toolExecutions.getById(`c${i}`);
      } catch (error) {
        getError = error;
      }
      expect(getError).toBeInstanceOf(ToolExecutionError);
      if (getError instanceof ToolExecutionError) {
        expect(getError.code).toBe("persistence");
      }
      let listError: unknown;
      try {
        repos.toolExecutions.listRecent(10);
      } catch (error) {
        listError = error;
      }
      expect(listError).toBeInstanceOf(ToolExecutionError);
      if (listError instanceof ToolExecutionError) {
        expect(listError.code).toBe("persistence");
      }
    });
    let message = "";
    try {
      repos.toolExecutions.getById("c0");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("broken");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("2026-99-99");
    expect(message).not.toContain("-1");
    cleanup();
  });
});
