import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { AgentWorkerEventSchema, AgentWorkerRequestSchema } from "./chat.js";
import { ToolExecutionEventSchema } from "./tools.js";
import {
  HostReplySchema,
  HostRequestSchema,
  ToolEventEnvelopeSchema,
  ToolFailureCodeSchema,
  ToolRunRequestSchema,
  UtilityWorkerEventSchema,
  UtilityWorkerRequestSchema,
} from "./worker.js";

const chatRequest = {
  requestId: "r1",
  kind: "chat.prompt",
  prompt: "你好",
  context: { projectId: "p1", conversationId: "c1", systemPrompt: "sys", messages: [] },
  options: { webSearch: false },
  apiKey: "sk-test-key",
  modelId: "deepseek-v4-flash",
};

const toolRequest = {
  requestId: "r2",
  kind: "tool.run",
  executionId: "exec-1",
  traceId: "trace-1",
  tool: { name: "echo", version: 1 },
  input: { text: "hi" },
  actor: "developer_probe",
};

const auditStartPayload = {
  executionId: "exec-1",
  traceId: "trace-1",
  actor: "developer_probe",
  toolName: "echo",
  toolVersion: 1,
};

describe("utility worker protocol", () => {
  it("keeps chat requests valid and adds tool.run to the union", () => {
    expect(Value.Check(AgentWorkerRequestSchema, chatRequest)).toBe(true);
    expect(Value.Check(ToolRunRequestSchema, toolRequest)).toBe(true);
    expect(Value.Check(UtilityWorkerRequestSchema, chatRequest)).toBe(true);
    expect(Value.Check(UtilityWorkerRequestSchema, toolRequest)).toBe(true);
  });

  it("rejects blank IDs, extra properties and malformed tool.run kinds", () => {
    expect(Value.Check(ToolRunRequestSchema, { ...toolRequest, requestId: "" })).toBe(false);
    expect(Value.Check(ToolRunRequestSchema, { ...toolRequest, executionId: "" })).toBe(false);
    expect(Value.Check(ToolRunRequestSchema, { ...toolRequest, traceId: "" })).toBe(false);
    expect(Value.Check(ToolRunRequestSchema, { ...toolRequest, kind: "tool.bogus" })).toBe(false);
    expect(Value.Check(ToolRunRequestSchema, { ...toolRequest, extra: 1 })).toBe(false);
    expect(
      Value.Check(ToolRunRequestSchema, { ...toolRequest, tool: { name: "", version: 1 } }),
    ).toBe(false);
    expect(Value.Check(ToolRunRequestSchema, { ...toolRequest, actor: "not_an_actor" })).toBe(
      false,
    );
    expect(
      Value.Check(ToolRunRequestSchema, { ...toolRequest, toolSet: { evil: true } }),
    ).toBe(false);
    expect(Value.Check(ToolRunRequestSchema, { ...toolRequest, input: { text: 1n } })).toBe(false);
  });

  it("accepts a non-empty projectId and rejects a blank one", () => {
    expect(Value.Check(ToolRunRequestSchema, { ...toolRequest, projectId: "p1" })).toBe(true);
    expect(Value.Check(ToolRunRequestSchema, { ...toolRequest, projectId: "" })).toBe(false);
  });

  it("keeps chat events valid and wraps tool events in strict envelopes in the event union", () => {
    const chatEvent = { requestId: "r1", type: "started" };
    const toolEvent = {
      executionId: "exec-1",
      traceId: "trace-1",
      tool: { name: "echo", version: 1 },
      sequence: 0,
      timestamp: 0,
      type: "started",
    };
    const envelope = { kind: "tool.event", requestId: "r2", event: toolEvent };
    expect(Value.Check(AgentWorkerEventSchema, chatEvent)).toBe(true);
    expect(Value.Check(ToolExecutionEventSchema, toolEvent)).toBe(true);
    expect(Value.Check(UtilityWorkerEventSchema, chatEvent)).toBe(true);
    expect(Value.Check(ToolEventEnvelopeSchema, envelope)).toBe(true);
    expect(Value.Check(UtilityWorkerEventSchema, envelope)).toBe(true);
    // raw tool events are no longer part of the Utility event union: the
    // envelope with its transport generation id is the only tool carrier.
    expect(Value.Check(UtilityWorkerEventSchema, toolEvent)).toBe(false);
    expect(
      Value.Check(ToolEventEnvelopeSchema, { kind: "tool.event", requestId: "", event: toolEvent }),
    ).toBe(false);
    expect(
      Value.Check(ToolEventEnvelopeSchema, { kind: "tool.event", requestId: "r2", event: { ...toolEvent, executionId: "" } }),
    ).toBe(false);
  });

  it("validates method-discriminated host replies strictly", () => {
    const auditOk = {
      hostRequestId: "h1",
      kind: "host.reply",
      method: "audit.start",
      ok: true,
      payload: { acknowledged: true },
    };
    const secretOk = {
      hostRequestId: "h1",
      kind: "host.reply",
      method: "secret.getProviderKey",
      ok: true,
      payload: { apiKey: "k" },
    };
    const errorReply = {
      hostRequestId: "h1",
      kind: "host.reply",
      method: "audit.finish",
      ok: false,
      code: "audit_failed",
    };
    expect(Value.Check(HostReplySchema, auditOk)).toBe(true);
    expect(Value.Check(HostReplySchema, { ...auditOk, method: "audit.finish" })).toBe(true);
    expect(Value.Check(HostReplySchema, secretOk)).toBe(true);
    expect(Value.Check(HostReplySchema, { ...secretOk, payload: { apiKey: null } })).toBe(true);
    expect(Value.Check(HostReplySchema, errorReply)).toBe(true);
    // cross-method payloads are rejected at schema level
    expect(
      Value.Check(HostReplySchema, { ...auditOk, payload: { apiKey: "sk-secret" } }),
    ).toBe(false);
    expect(
      Value.Check(HostReplySchema, { ...secretOk, payload: { acknowledged: true } }),
    ).toBe(false);
    expect(Value.Check(HostReplySchema, { ...auditOk, payload: { secret: "x" } })).toBe(false);
    // arbitrary error codes are rejected
    expect(Value.Check(HostReplySchema, { ...errorReply, code: "sk-secret-raw" })).toBe(false);
    expect(
      Value.Check(HostReplySchema, { hostRequestId: "", kind: "host.reply", method: "audit.start", ok: true, payload: { acknowledged: true } }),
    ).toBe(false);
    expect(Value.Check(HostReplySchema, { ...auditOk, extra: 1 })).toBe(false);
  });

  it("enforces status ↔ errorCode consistency on audit.finish at schema level", () => {
    const base = { executionId: "e", traceId: "t", attempts: 1 };
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.finish",
        payload: { ...base, status: "completed" },
      }),
    ).toBe(true);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.finish",
        payload: { ...base, status: "completed", errorCode: "timeout" },
      }),
    ).toBe(false);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.finish",
        payload: { ...base, status: "failed" },
      }),
    ).toBe(false);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.finish",
        payload: { ...base, status: "failed", errorCode: "rate_limited" },
      }),
    ).toBe(true);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.finish",
        payload: { ...base, status: "cancelled", errorCode: "cancelled" },
      }),
    ).toBe(true);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.finish",
        payload: { ...base, status: "failed", errorCode: "sk-secret-raw" },
      }),
    ).toBe(false);
  });

  it("keeps the tool failure code literals aligned with the wire schema", () => {
    const literalValues: string[] = [];
    for (const member of ToolFailureCodeSchema.anyOf as Array<{ const?: string }>) {
      if (typeof member.const === "string") {
        literalValues.push(member.const);
      }
    }
    expect(literalValues.length).toBeGreaterThan(10);
    expect(literalValues).toContain("rate_limited");
    expect(literalValues).toContain("audit_failed");
    expect(literalValues).not.toContain("__proto__");
  });

  it("accepts the host.protocol failure variant for malformed/disposed cases", () => {
    const protocol = { hostRequestId: "h1", kind: "host.reply", method: "host.protocol", ok: false, code: "host_disposed" };
    expect(Value.Check(HostReplySchema, protocol)).toBe(true);
    expect(Value.Check(HostReplySchema, { ...protocol, code: "invalid_request" })).toBe(true);
    expect(Value.Check(HostReplySchema, { ...protocol, code: "host_protocol_error" })).toBe(true);
    expect(Value.Check(HostReplySchema, { ...protocol, code: "sk-secret-raw" })).toBe(false);
    expect(Value.Check(HostReplySchema, { ...protocol, ok: true, payload: { acknowledged: true } })).toBe(false);
    expect(
      Value.Check(HostReplySchema, {
        hostRequestId: "h1",
        kind: "host.reply",
        method: "audit.start",
        ok: false,
        code: "host_disposed",
      }),
    ).toBe(true);
  });

  it("validates host requests strictly and rejects secrets, SQL and unknown providers", () => {
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.start",
        payload: auditStartPayload,
      }),
    ).toBe(true);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.finish",
        payload: { executionId: "e", traceId: "t", status: "failed", attempts: 2, errorCode: "rate_limited" },
      }),
    ).toBe(true);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "secret.getProviderKey",
        payload: { provider: "deepseek" },
      }),
    ).toBe(true);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "secret.getProviderKey",
        payload: { provider: "anthropic" },
      }),
    ).toBe(false);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "secret.get",
        payload: { name: "x" },
      }),
    ).toBe(false);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.start",
        payload: { ...auditStartPayload, apiKey: "sk-secret" },
      }),
    ).toBe(false);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.start",
        payload: { ...auditStartPayload, sql: "DROP TABLE x" },
      }),
    ).toBe(false);
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "",
        kind: "host.request",
        method: "audit.start",
        payload: auditStartPayload,
      }),
    ).toBe(false);
  });
});
