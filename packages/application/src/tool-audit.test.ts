import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolAuditFinish, ToolAuditStart } from "@deepfield/tool-platform";
import {
  FakeRetryClock,
  ToolBudgetLedger,
  ToolPolicy,
  ToolRegistry,
  ToolRunner,
  ToolSet,
} from "@deepfield/tool-platform";
import { ToolExecutionError } from "@deepfield/persistence";
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

describe("SqliteToolAudit", () => {
  it("persists start with whitelisted fields and no summaries", async () => {
    const { db, audit } = openAuditDb();
    await audit.start({ ...startRecord, projectId: "proj-1" });
    const record = db.repos.toolExecutions.getById("exec-1");
    expect(record).toMatchObject({
      traceId: "trace-1",
      projectId: "proj-1",
      actor: "developer_probe",
      toolName: "echo",
      toolVersion: 1,
      status: "running",
      attempts: 0,
    });
    expect(record?.inputSummary).toBeUndefined();
    expect(record?.outputSummary).toBeUndefined();
  });

  it("finishes with completed and mapped counters", async () => {
    const { db, audit } = openAuditDb();
    await audit.start(startRecord);
    await audit.finish({
      executionId: "exec-1",
      traceId: "trace-1",
      status: "completed",
      attempts: 2,
      durationMs: 500,
    });
    const record = db.repos.toolExecutions.getById("exec-1");
    expect(record).toMatchObject({
      status: "completed",
      attempts: 2,
      retries: 1,
      bytesReceived: 0,
      resultCount: 0,
      durationMs: 500,
    });
    expect(record?.finishedAt).toBeDefined();
    expect(record?.errorCode).toBeUndefined();
  });

  it("persists only the failure code for failed executions", async () => {
    const { db, audit } = openAuditDb();
    await audit.start(startRecord);
    await audit.finish({
      executionId: "exec-1",
      traceId: "trace-1",
      status: "failed",
      attempts: 3,
      failure: {
        code: "rate_limited",
        message: "secret provider message",
        retryable: true,
        attempts: 3,
      },
    });
    const row = db.db
      .prepare("SELECT error_code, output_summary_json FROM tool_executions WHERE id='exec-1'")
      .get() as { error_code: string | null; output_summary_json: string | null };
    expect(row.error_code).toBe("rate_limited");
    expect(row.output_summary_json).toBeNull();
    const record = db.repos.toolExecutions.getById("exec-1");
    expect(record?.status).toBe("failed");
    expect(record?.retries).toBe(2);
    expect(record?.errorCode).toBe("rate_limited");
    const all = db.db.prepare("SELECT * FROM tool_executions").all();
    expect(JSON.stringify(all)).not.toContain("secret provider message");
  });

  it("persists cancelled status", async () => {
    const { db, audit } = openAuditDb();
    await audit.start(startRecord);
    await audit.finish({
      executionId: "exec-1",
      traceId: "trace-1",
      status: "cancelled",
      attempts: 1,
      failure: { code: "cancelled", message: "x", retryable: false, attempts: 1 },
    });
    expect(db.repos.toolExecutions.getById("exec-1")?.status).toBe("cancelled");
  });

  it("drops unknown extra fields such as input/output/body/apiKey/cause", async () => {
    const { db, audit } = openAuditDb();
    const record = {
      ...startRecord,
      input: { body: "secret body" },
      output: { text: "secret text" },
      body: "b",
      apiKey: "sk-secret",
      cause: new Error("boom"),
      headers: { authorization: "Bearer x" },
    } as unknown as ToolAuditStart;
    await audit.start(record);
    const row = db.db
      .prepare(
        "SELECT input_summary_json, output_summary_json, error_code FROM tool_executions WHERE id='exec-1'",
      )
      .get() as { input_summary_json: string | null; output_summary_json: string | null; error_code: string | null };
    expect(row.input_summary_json).toBeNull();
    expect(row.output_summary_json).toBeNull();
    expect(row.error_code).toBeNull();
    const all = db.db.prepare("SELECT * FROM tool_executions").all();
    const serialized = JSON.stringify(all);
    expect(serialized).not.toContain("secret body");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("Bearer");
  });

  it("propagates start persistence failure as a sanitized error", async () => {
    const { audit } = openAuditDb();
    await audit.start(startRecord);
    await expect(audit.start(startRecord)).rejects.toBeInstanceOf(SqliteToolAuditError);
    try {
      await audit.start(startRecord);
    } catch (error) {
      expect((error as Error).message).not.toContain("exec-1");
    }
  });

  it("propagates finish persistence failure as a sanitized error", async () => {
    const { audit } = openAuditDb();
    const finish: ToolAuditFinish = {
      executionId: "missing",
      traceId: "trace-1",
      status: "completed",
      attempts: 1,
    };
    await expect(audit.finish(finish)).rejects.toBeInstanceOf(SqliteToolAuditError);
  });

  it("rejects unknown failure codes without persisting them", async () => {
    const { db, audit } = openAuditDb();
    await audit.start(startRecord);
    await expect(
      audit.finish({
        executionId: "exec-1",
        traceId: "trace-1",
        status: "failed",
        attempts: 1,
        failure: { code: "sk-secret-provider-value", message: "x", retryable: false, attempts: 1 },
      } as unknown as ToolAuditFinish),
    ).rejects.toBeInstanceOf(SqliteToolAuditError);
    const row = db.db
      .prepare("SELECT status, error_code FROM tool_executions WHERE id='exec-1'")
      .get() as { status: string; error_code: string | null };
    expect(row.status).toBe("running");
    expect(row.error_code).toBeNull();
    const all = db.db.prepare("SELECT * FROM tool_executions").all();
    expect(JSON.stringify(all)).not.toContain("sk-secret-provider-value");
  });

  it("never forwards an out-of-contract failure code to the repository", async () => {
    let captured: unknown;
    const capturing: ToolExecutionRepository = {
      start: () => {},
      finish: (record) => {
        captured = record;
      },
      getById: () => undefined,
      listRecent: () => [],
    };
    const audit = new SqliteToolAudit(capturing);
    await audit.start(startRecord);
    await expect(
      audit.finish({
        executionId: "exec-1",
        traceId: "trace-1",
        status: "failed",
        attempts: 1,
        failure: { code: "sk-secret-provider-value", message: "x", retryable: false, attempts: 1 },
      } as unknown as ToolAuditFinish),
    ).rejects.toBeInstanceOf(SqliteToolAuditError);
    expect(captured).toBeUndefined();
  });

  it("runner never reports completed when final audit persistence fails", async () => {
    const failingRepository: ToolExecutionRepository = {
      start: () => {},
      finish: () => {
        throw new ToolExecutionError("not_found", "tool execution not found");
      },
      getById: () => undefined,
      listRecent: () => [],
    };
    const audit = new SqliteToolAudit(failingRepository);
    const clock = new FakeRetryClock();
    const registry = new ToolRegistry();
    registry.register({
      identity: { name: "echo", version: 1 },
      label: "Echo",
      description: "test",
      inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
      effect: "network.read.public",
      timeoutMs: 1000,
      retry: { maxRetries: 0, backoffMs: 0 },
      concurrency: 1,
      meter: { category: "none", countsBytes: false, countsTime: true },
      execute: async ({ text }) => ({ text }),
    });
    const runner = new ToolRunner({
      registry,
      policy: new ToolPolicy(),
      budget: new ToolBudgetLedger({}, () => clock.now()),
      audit,
      clock,
    });
    const toolSet = new ToolSet([
      { identity: { name: "echo", version: 1 }, actor: "developer_probe", effect: "network.read.public" },
    ]);
    const result = await runner.execute(
      { executionId: "exec-1", traceId: "trace-1", tool: { name: "echo", version: 1 }, input: { text: "hi" } },
      { traceId: "trace-1", actor: "developer_probe", toolSet },
      new AbortController().signal,
      () => {},
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("audit_failed");
    }
  });
});
