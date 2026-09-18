import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolAuditFinish, ToolAuditSink, ToolAuditStart } from "@deepfield/tool-platform";
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
import { openTestDb, type TestDb } from "../testing/application-test-helpers.js";
import { SqliteToolAudit, SqliteToolAuditError } from "./tool-audit.js";
import { createSearchWebDefinition } from "@deepfield/retrieval";
import { ChatService } from "../chat/chat-service.js";

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

  it("persists optional turn, batch, and tool-call scope for admitted executions", async () => {
    const { db, audit } = openAuditDb();
    await audit.start({
      ...startRecord,
      executionId: "scoped-exec",
      agentTurnIndex: 4,
      batchId: "batch-4",
      toolCallId: "call-9",
    } as ToolAuditStart & { agentTurnIndex: number; batchId: string; toolCallId: string });
    expect(db.repos.toolExecutions.getById("scoped-exec")).toMatchObject({
      agentTurnIndex: 4,
      batchId: "batch-4",
      toolCallId: "call-9",
      budgetConsumed: false,
    });
  });

  it.each([
    { name: "pre-aborted", input: { query: "x" }, abort: true, expectedStatus: "cancelled", expectedProviderCalls: 0, expectedBudgetConsumed: false, expectedConsumed: 0 },
    {
      name: "reversed-date",
      input: { query: "x", timeRange: { from: "2026-03-01", to: "2026-02-01" } },
      abort: false,
      expectedStatus: "failed",
      expectedProviderCalls: 0,
      expectedBudgetConsumed: false,
      expectedConsumed: 0,
    },
    { name: "dispatched", input: { query: "x" }, abort: false, expectedStatus: "completed", expectedProviderCalls: 1, expectedBudgetConsumed: true, expectedConsumed: 1 },
  ])("persists truthful dispatch consumption for $name search", async ({ input, abort, expectedStatus, expectedProviderCalls, expectedBudgetConsumed, expectedConsumed }) => {
    const { db, audit } = openAuditDb();
    let providerCalls = 0;
    const registry = new ToolRegistry();
    registry.register(createSearchWebDefinition({
      id: "test",
      capabilities: { timeRange: false },
      async search() {
        providerCalls += 1;
        return { provider: "test", results: [] };
      },
    }));
    registry.freeze();
    const toolSet = new ToolSet([{
      identity: { name: "web_search", version: 1 },
      actor: "main_agent",
      effect: "network.read.public",
    }]);
    const budget = new ToolBudgetLedger({ maxCalls: 2 });
    const runner = new ToolRunner({
      registry,
      policy: new ToolPolicy(),
      budget,
      audit,
      clock: new FakeRetryClock(),
    });
    const controller = new AbortController();
    if (abort) controller.abort();
    const result = await runner.execute(
      {
        executionId: `exec-${expectedStatus}`,
        traceId: "trace-1",
        tool: { name: "web_search", version: 1 },
        input,
      },
      { traceId: "trace-1", actor: "main_agent", toolSet },
      controller.signal,
      () => {},
    );
    expect(result.status).toBe(expectedStatus);
    expect(providerCalls).toBe(expectedProviderCalls);
    expect(budget.snapshot().total).toMatchObject({ reserved: 0, consumed: expectedConsumed });
    expect(db.repos.toolExecutions.getById(`exec-${expectedStatus}`)).toMatchObject({
      status: expectedStatus,
      budgetConsumed: expectedBudgetConsumed,
    });
  });

  it("reloads an ordinary zero-attempt Runner timeout from SQLite and chat history", async () => {
    const { db, audit: sqliteAudit } = openAuditDb();
    let tick = 0;
    const clock = {
      now: () => tick++,
      wait: async () => undefined,
    };
    const audit: ToolAuditSink = {
      start: (record) => sqliteAudit.start(record),
      finish: (record) => sqliteAudit.finish(record),
      recordSynthetic: (record) => sqliteAudit.recordSynthetic(record),
    };
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register({
      identity: { name: "deadline_probe", version: 1 },
      label: "Deadline probe",
      description: "test",
      inputSchema: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
      effect: "local.compute",
      timeoutMs: 1,
      retry: { maxRetries: 0, backoffMs: 0 },
      concurrency: 1,
      meter: { category: "none", countsBytes: false, countsTime: true },
      async execute() {
        executions += 1;
        return { ok: true };
      },
    });
    registry.freeze();
    const runner = new ToolRunner({
      registry,
      policy: new ToolPolicy(),
      budget: new ToolBudgetLedger({}, () => clock.now()),
      audit,
      clock,
    });
    const toolSet = new ToolSet([{
      identity: { name: "deadline_probe", version: 1 },
      actor: "main_agent",
      effect: "local.compute",
    }]);
    const conversation = db.repos.conversations.create();
    db.repos.conversations.activate(conversation.id, "Deadline test");
    db.repos.messages.append(conversation.id, "user", "run", "req-deadline");
    db.repos.messages.append(conversation.id, "assistant", "timed out", "req-deadline");

    const result = await runner.execute(
      {
        executionId: "deadline-timeout",
        traceId: "req-deadline",
        tool: { name: "deadline_probe", version: 1 },
        input: {},
      },
      { traceId: "req-deadline", actor: "main_agent", toolSet },
      new AbortController().signal,
      () => undefined,
    );

    expect(result).toMatchObject({
      status: "failed",
      attempts: 0,
      budgetConsumed: false,
      failure: { code: "timeout" },
    });
    expect(executions).toBe(0);
    expect(db.repos.toolExecutions.getById("deadline-timeout")).toMatchObject({
      status: "failed",
      attempts: 0,
      budgetConsumed: false,
      errorCode: "timeout",
    });
    const messages = new ChatService(
      db.repos,
      {} as never,
      {} as never,
      {} as never,
    ).listMessages(conversation.id);
    expect(messages[1]?.toolExecutions).toEqual([
      expect.objectContaining({
        callKey: "deadline-timeout",
        name: "deadline_probe",
        status: "failed",
        budgetConsumed: false,
        errorCode: "timeout",
      }),
    ]);
  });

  it("finishes with completed and mapped counters", async () => {
    const { db, audit } = openAuditDb();
    await audit.start(startRecord);
    await audit.finish({
      executionId: "exec-1",
      traceId: "trace-1",
      status: "completed",
      attempts: 2,
      budgetConsumed: true,
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
      budgetConsumed: true,
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
      budgetConsumed: true,
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
      budgetConsumed: true,
    };
    await expect(audit.finish(finish)).rejects.toBeInstanceOf(SqliteToolAuditError);
  });

  it.each([
    { status: "completed" as const },
    {
      status: "failed" as const,
      failure: { code: "timeout" as const, message: "timed out", retryable: false, attempts: 0 },
    },
    { status: "cancelled" as const },
  ])("rejects consumed budget without an attempt for $status persistence", async (terminal) => {
    const { db, audit } = openAuditDb();
    await audit.start(startRecord);

    await expect(audit.finish({
      executionId: "exec-1",
      traceId: "trace-1",
      attempts: 0,
      budgetConsumed: true,
      ...terminal,
    })).rejects.toBeInstanceOf(SqliteToolAuditError);

    expect(db.repos.toolExecutions.getById("exec-1")).toMatchObject({
      status: "running",
      attempts: 0,
      budgetConsumed: false,
    });
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
        budgetConsumed: true,
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
      recordSynthetic: () => {},
      getById: () => undefined,
          listRecent: () => [], listByConversation: () => [],
    };
    const audit = new SqliteToolAudit(capturing);
    await audit.start(startRecord);
    await expect(
      audit.finish({
        executionId: "exec-1",
        traceId: "trace-1",
        status: "failed",
        attempts: 1,
        budgetConsumed: true,
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
      recordSynthetic: () => {},
      getById: () => undefined,
          listRecent: () => [], listByConversation: () => [],
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
