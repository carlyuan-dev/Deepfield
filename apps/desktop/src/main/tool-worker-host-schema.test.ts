import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { HostReplySchema } from "@deepfield/contracts";
import type { ToolAuditSink } from "@deepfield/tool-platform";
import { HostClient, HostRpcError } from "../worker/host-client.js";
import { createToolWorkerHost, type ToolWorkerHost } from "./tool-worker-host.js";

function fakeAudit(): { audit: ToolAuditSink } {
  return {
    audit: {
      async start() {},
      async finish() {},
    },
  };
}

function createHost(audit: ToolAuditSink): { host: ToolWorkerHost; posted: unknown[] } {
  const posted: unknown[] = [];
  const host = createToolWorkerHost({ audit, secrets: { get: () => undefined }, postMessage: (value) => posted.push(value) });
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

describe("tool worker host reply schema (focused revision)", () => {
  it("every host reply passes HostReplySchema, including disposed and invalid branches", async () => {
    const { audit } = fakeAudit();
    const { host, posted } = createHost(audit);
    host.handleRequest(auditStart);
    host.handleRequest({ ...auditStart, hostRequestId: "h2", payload: { ...auditStart.payload, apiKey: "sk-x" } });
    await Promise.resolve();
    host.dispose();
    host.handleRequest({ ...auditStart, hostRequestId: "h3" });
    await Promise.resolve();
    expect(posted.length).toBeGreaterThan(0);
    for (const value of posted) {
      expect(Value.Check(HostReplySchema, value)).toBe(true);
    }
  });

  it("settles a valid pending request with a same-method host_disposed reply after dispose", async () => {
    const { audit } = fakeAudit();
    let client!: HostClient;
    let host!: ToolWorkerHost;
    host = createToolWorkerHost({
      audit,
      secrets: { get: () => undefined },
      postMessage: (value) => client.handleReply(value),
    });
    client = new HostClient({
      postMessage: (value) => host.handleRequest(value),
      timeoutMs: 1000,
    });
    host.dispose();
    const request = client.request("audit.start", {
      executionId: "a",
      traceId: "t",
      actor: "developer_probe",
      toolName: "echo",
      toolVersion: 1,
    });
    const error = await request.catch((caught) => caught);
    expect(error).toBeInstanceOf(HostRpcError);
    expect((error as HostRpcError).code).toBe("host_disposed");
    expect(client.pendingCount()).toBe(0);
  });

  it("replies a schema-valid host.protocol variant for malformed requests", async () => {
    const { audit } = fakeAudit();
    const { host, posted } = createHost(audit);
    host.handleRequest({
      hostRequestId: "h9",
      kind: "host.request",
      method: "secret.get",
      payload: { name: "anything" },
    });
    await Promise.resolve();
    expect(posted).toHaveLength(1);
    expect(Value.Check(HostReplySchema, posted[0])).toBe(true);
    expect(posted[0]).toMatchObject({
      hostRequestId: "h9",
      kind: "host.reply",
      method: "host.protocol",
      ok: false,
      code: "invalid_request",
    });
  });
});
