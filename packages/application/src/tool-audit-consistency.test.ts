import { afterEach, describe, expect, it } from "vitest";
import type { ToolAuditFinish, ToolAuditStart } from "@deepfield/tool-platform";
import type { ToolExecutionRepository } from "@deepfield/persistence";
import { openTestDb, type TestDb } from "./application-test-helpers.js";
import { SqliteToolAudit, SqliteToolAuditError } from "./tool-audit.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

function openAuditDb(): { db: TestDb; audit: SqliteToolAudit } {
  const db = openTestDb();
  dbs.push(db);
  return { db, audit: new SqliteToolAudit(db.repos.toolExecutions) };
}

const startRecord: ToolAuditStart = {
  executionId: "exec-1",
  traceId: "trace-1",
  actor: "developer_probe",
  tool: { name: "echo", version: 1 },
  attempts: 0,
};

describe("SqliteToolAudit finish consistency (focused revision)", () => {
  it("rejects contradictory finish status and failure combinations without touching the row", async () => {
    const { db, audit } = openAuditDb();
    await audit.start(startRecord);
    await expect(
      audit.finish({
        executionId: "exec-1",
        traceId: "trace-1",
        status: "completed",
        attempts: 1,
        failure: { code: "timeout", message: "x", retryable: false, attempts: 1 },
      } as unknown as ToolAuditFinish),
    ).rejects.toBeInstanceOf(SqliteToolAuditError);
    await expect(
      audit.finish({
        executionId: "exec-1",
        traceId: "trace-1",
        status: "failed",
        attempts: 1,
      } as unknown as ToolAuditFinish),
    ).rejects.toBeInstanceOf(SqliteToolAuditError);
    const row = db.db
      .prepare("SELECT status, error_code FROM tool_executions WHERE id='exec-1'")
      .get() as { status: string; error_code: string | null };
    expect(row.status).toBe("running");
    expect(row.error_code).toBeNull();
    const all = db.db.prepare("SELECT * FROM tool_executions").all();
    expect(JSON.stringify(all)).not.toContain("timeout");
  });

  it("never forwards contradictory finish combinations to the repository", async () => {
    let finishCalls = 0;
    const capturing: ToolExecutionRepository = {
      start: () => {},
      finish: () => {
        finishCalls += 1;
      },
      getById: () => undefined,
          listRecent: () => [], listByConversation: () => [],
    };
    const audit = new SqliteToolAudit(capturing);
    await audit.start(startRecord);
    await expect(
      audit.finish({
        executionId: "exec-1",
        traceId: "trace-1",
        status: "completed",
        attempts: 1,
        failure: { code: "timeout", message: "x", retryable: false, attempts: 1 },
      } as unknown as ToolAuditFinish),
    ).rejects.toBeInstanceOf(SqliteToolAuditError);
    await expect(
      audit.finish({
        executionId: "exec-1",
        traceId: "trace-1",
        status: "failed",
        attempts: 1,
      } as unknown as ToolAuditFinish),
    ).rejects.toBeInstanceOf(SqliteToolAuditError);
    expect(finishCalls).toBe(0);
  });
});
