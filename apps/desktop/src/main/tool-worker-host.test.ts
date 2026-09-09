import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolAuditFinish, ToolAuditSink, ToolAuditStart } from "@deepfield/tool-platform";
import { SqliteToolAudit } from "@deepfield/application";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import {
  createConversationToolDefinitions,
  type ConversationToolName,
} from "@deepfield/utility-tools";
import { HostClient, createHostConversationReader } from "../worker/host-client.js";
import { createToolWorkerHost, type ToolWorkerHost } from "./tool-worker-host.js";

interface FakeAuditOptions {
  finishGate?: { promise: Promise<void>; resolve: () => void };
  failFinish?: boolean;
}

function fakeAudit(options: FakeAuditOptions = {}): {
  audit: ToolAuditSink;
  starts: ToolAuditStart[];
  finishes: ToolAuditFinish[];
} {
  const starts: ToolAuditStart[] = [];
  const finishes: ToolAuditFinish[] = [];
  return {
    starts,
    finishes,
    audit: {
      async start(record) {
        starts.push(record);
      },
      async finish(record) {
        if (options.failFinish) {
          throw new Error("audit finish failed");
        }
        finishes.push(record);
        if (options.finishGate) {
          await options.finishGate.promise;
        }
      },
    },
  };
}

function createHost(
  audit: ToolAuditSink,
  secrets: { get(name: string): string | undefined } = { get: () => undefined },
): { host: ToolWorkerHost; posted: unknown[] } {
  const posted: unknown[] = [];
  const host = createToolWorkerHost({ audit, secrets, postMessage: (value) => posted.push(value) });
  return { host, posted };
}

const auditStart = {
  hostRequestId: "h1",
  kind: "host.request",
  method: "audit.start",
  payload: {
    executionId: "exec-1",
    traceId: "trace-1",
    actor: "developer_probe",
    toolName: "echo",
    toolVersion: 1,
  },
};

const auditFinish = {
  hostRequestId: "h2",
  kind: "host.request",
  method: "audit.finish",
  payload: { executionId: "exec-1", traceId: "trace-1", status: "failed", attempts: 2, errorCode: "rate_limited" },
};

describe("tool worker host", () => {
  it("lists, reads and searches bounded conversation data over the narrow host RPC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "df-conversations-"));
    const db = openDatabase(join(dir, "t.sqlite"));
    migrate(db);
    const repositories = createRepositories(db);
    const first = repositories.conversations.create();
    repositories.conversations.activate(first.id, "Alpha plan");
    repositories.messages.append(first.id, "user", "Alpha   launch\nnotes");
    repositories.messages.append(first.id, "assistant", "First answer");
    const second = repositories.conversations.create();
    repositories.conversations.activate(second.id, "Recent discussion");
    repositories.messages.append(second.id, "user", "We mention ALPHA later");

    const { audit } = fakeAudit();
    let client!: HostClient;
    const host = createToolWorkerHost({
      audit,
      secrets: { get: () => undefined },
      conversationRepositories: {
        conversations: repositories.conversations,
        messages: repositories.messages,
      },
      postMessage: (value) => client.handleReply(value),
    });
    client = new HostClient({ postMessage: (value) => host.handleRequest(value) });
    const definitions = createConversationToolDefinitions(createHostConversationReader(client));
    const execute = (name: ConversationToolName, input: Record<string, unknown>) => {
      const definition = definitions.find((candidate) => candidate.identity.name === name);
      if (definition === undefined) throw new Error(`missing definition ${name}`);
      return definition.execute(
        input as never,
        { traceId: "trace-1", actor: "main_agent" },
        new AbortController().signal,
      );
    };

    const listed = await execute("list_conversations", {});
    expect(listed).toMatchObject({
      conversations: [{ id: second.id }, { id: first.id }],
    });
    const read = await execute("read_conversation", { conversationId: first.id });
    expect(read).toEqual({
      conversationId: first.id,
      title: "Alpha plan",
      messages: [
        { role: "user", content: "Alpha   launch\nnotes" },
        { role: "assistant", content: "First answer" },
      ],
    });
    const searched = await execute("search_conversations", { query: "alpha" });
    expect(searched).toMatchObject({
      results: [
        { conversationId: second.id, title: "Recent discussion", snippet: "We mention ALPHA later" },
        { conversationId: first.id, title: "Alpha plan", snippet: "Alpha plan" },
      ],
    });
    expect(JSON.stringify(searched)).not.toContain("  ");
    await expect(
      execute("read_conversation", { conversationId: "missing" }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    client.dispose();
    host.dispose();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists audit start and acknowledges", async () => {
    const { audit, starts } = fakeAudit();
    const { host, posted } = createHost(audit);
    host.handleRequest(auditStart);
    await Promise.resolve();
    expect(starts).toHaveLength(1);
    expect(starts[0]!.executionId).toBe("exec-1");
    expect(posted).toEqual([
      {
        hostRequestId: "h1",
        kind: "host.reply",
        method: "audit.start",
        ok: true,
        payload: { acknowledged: true },
      },
    ]);
  });

  it("does not acknowledge audit.finish before the audit sink resolves (ack gate)", async () => {
    let resolveFinish!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFinish = resolve;
    });
    const { audit, finishes } = fakeAudit({ finishGate: { promise: gate, resolve: resolveFinish } });
    const { host, posted } = createHost(audit);
    host.handleRequest(auditFinish);
    await Promise.resolve();
    expect(finishes).toHaveLength(1);
    expect(posted).toEqual([]);
    resolveFinish();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(posted).toEqual([
      {
        hostRequestId: "h2",
        kind: "host.reply",
        method: "audit.finish",
        ok: true,
        payload: { acknowledged: true },
      },
    ]);
  });

  it("replies a fixed safe code when audit finish fails and never claims success", async () => {
    const { audit } = fakeAudit({ failFinish: true });
    const { host, posted } = createHost(audit);
    host.handleRequest(auditFinish);
    await Promise.resolve();
    expect(posted).toEqual([
      {
        hostRequestId: "h2",
        kind: "host.reply",
        method: "audit.finish",
        ok: false,
        code: "audit_failed",
      },
    ]);
    expect(JSON.stringify(posted)).not.toContain("audit finish failed");
  });

  it("resolves provider keys only for the allowlisted provider and never leaks", async () => {
    const reads: string[] = [];
    const secrets = {
      get: (name: string) => {
        reads.push(name);
        return name === "deepseek.apiKey" ? "sk-secret-value" : undefined;
      },
    };
    const { audit } = fakeAudit();
    const { host, posted } = createHost(audit, secrets);
    host.handleRequest({
      hostRequestId: "h3",
      kind: "host.request",
      method: "secret.getProviderKey",
      payload: { provider: "deepseek" },
    });
    await Promise.resolve();
    expect(reads).toEqual(["deepseek.apiKey"]);
    expect(posted).toEqual([
      {
        hostRequestId: "h3",
        kind: "host.reply",
        method: "secret.getProviderKey",
        ok: true,
        payload: { apiKey: "sk-secret-value" },
      },
    ]);
  });

  it("rejects invalid, unknown or secret-bearing host requests without calling the audit", async () => {
    const { audit, starts, finishes } = fakeAudit();
    const { host, posted } = createHost(audit);
    host.handleRequest({ ...auditStart, method: "secret.get", payload: { name: "anything" } });
    host.handleRequest({ ...auditStart, payload: { ...auditStart.payload, apiKey: "sk-x" } });
    host.handleRequest({ hostRequestId: "h9", kind: "host.request", method: "audit.start", payload: { sql: "DROP" } });
    host.handleRequest({ hostRequestId: "", kind: "host.request", method: "audit.start", payload: auditStart.payload });
    await Promise.resolve();
    expect(starts).toHaveLength(0);
    expect(finishes).toHaveLength(0);
    const errors = posted.filter((value) => (value as { ok?: boolean }).ok === false);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect((error as { code?: string }).code).toBe("invalid_request");
    }
    expect(JSON.stringify(posted)).not.toContain("sk-x");
    expect(JSON.stringify(posted)).not.toContain("DROP");
  });

  it("replies host_disposed after dispose", async () => {
    const { audit } = fakeAudit();
    const { host, posted } = createHost(audit);
    host.dispose();
    host.handleRequest(auditStart);
    await Promise.resolve();
    expect(posted).toEqual([
      {
        hostRequestId: "h1",
        kind: "host.reply",
        method: "audit.start",
        ok: false,
        code: "host_disposed",
      },
    ]);
  });

  it("integrates with SqliteToolAudit over a real database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "df-host-"));
    const db = openDatabase(join(dir, "t.sqlite"));
    migrate(db);
    const repositories = createRepositories(db);
    const host = createToolWorkerHost({
      audit: new SqliteToolAudit(repositories.toolExecutions),
      secrets: { get: () => undefined },
      postMessage: () => {},
    });
    host.handleRequest(auditStart);
    host.handleRequest({
      hostRequestId: "h2",
      kind: "host.request",
      method: "audit.finish",
      payload: { executionId: "exec-1", traceId: "trace-1", status: "failed", attempts: 2, errorCode: "rate_limited" },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const record = repositories.toolExecutions.getById("exec-1");
    expect(record?.status).toBe("failed");
    expect(record?.errorCode).toBe("rate_limited");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("tool worker host lifecycle (focused revision)", () => {
  it("ignores a duplicate active request without a second audit call or a second reply", async () => {
    const { audit, starts } = fakeAudit();
    const { host, posted } = createHost(audit);
    host.handleRequest(auditStart);
    host.handleRequest(auditStart);
    await Promise.resolve();
    expect(starts).toHaveLength(1);
    expect(posted).toHaveLength(1);
  });

  it("never posts success after dispose, even when an in-flight audit later resolves", async () => {
    let resolveFinish!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFinish = resolve;
    });
    const { audit } = fakeAudit({ finishGate: { promise: gate, resolve: resolveFinish } });
    const { host, posted } = createHost(audit);
    host.handleRequest(auditFinish);
    await Promise.resolve();
    host.dispose();
    resolveFinish();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(posted).toEqual([]);
  });

  it("handles postMessage throws and secret lookup throws with fixed codes", async () => {
    const { audit } = fakeAudit();
    const posted: unknown[] = [];
    const host = createToolWorkerHost({
      audit,
      secrets: {
        get: () => {
          throw new Error("secret vault exploded");
        },
      },
      postMessage: (value) => posted.push(value),
    });
    host.handleRequest({
      hostRequestId: "h1",
      kind: "host.request",
      method: "secret.getProviderKey",
      payload: { provider: "deepseek" },
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(posted).toEqual([
      { hostRequestId: "h1", kind: "host.reply", method: "secret.getProviderKey", ok: false, code: "secret_unavailable" },
    ]);
    expect(JSON.stringify(posted)).not.toContain("vault exploded");
  });

  it("ignores a late duplicate of a completed request (bounded)", async () => {
    const { audit, starts } = fakeAudit();
    const { host, posted } = createHost(audit);
    host.handleRequest(auditStart);
    await Promise.resolve();
    host.handleRequest(auditStart);
    await Promise.resolve();
    expect(starts).toHaveLength(1);
    expect(posted).toHaveLength(1);
  });
});
