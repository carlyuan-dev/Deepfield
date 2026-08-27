import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { AgentWorkerEventSchema, AgentWorkerRequestSchema } from "./chat.js";
import { ToolExecutionEventSchema } from "./tools.js";
import {
  HostReplySchema,
  HostRequestSchema,
  ToolRunRequestSchema,
  UtilityWorkerEventSchema,
  UtilityWorkerRequestSchema,
} from "./worker.js";

const chatRequest = {
  requestId: "r1",
  kind: "chat.prompt",
  prompt: "你好",
  context: { projectId: "p1", conversationId: "c1", systemPrompt: "sys", messages: [] },
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

  it("keeps chat events valid and adds tool events and host replies to the event union", () => {
    const chatEvent = { requestId: "r1", type: "started" };
    const toolEvent = {
      executionId: "exec-1",
      traceId: "trace-1",
      tool: { name: "echo", version: 1 },
      sequence: 0,
      timestamp: 0,
      type: "started",
    };
    expect(Value.Check(AgentWorkerEventSchema, chatEvent)).toBe(true);
    expect(Value.Check(ToolExecutionEventSchema, toolEvent)).toBe(true);
    expect(Value.Check(UtilityWorkerEventSchema, chatEvent)).toBe(true);
    expect(Value.Check(UtilityWorkerEventSchema, toolEvent)).toBe(true);
  });

  it("validates host replies strictly", () => {
    expect(
      Value.Check(HostReplySchema, {
        hostRequestId: "h1",
        kind: "host.reply",
        ok: true,
        payload: { acknowledged: true },
      }),
    ).toBe(true);
    expect(
      Value.Check(HostReplySchema, {
        hostRequestId: "h1",
        kind: "host.reply",
        ok: true,
        payload: { apiKey: "k" },
      }),
    ).toBe(true);
    expect(
      Value.Check(HostReplySchema, {
        hostRequestId: "h1",
        kind: "host.reply",
        ok: true,
        payload: { apiKey: null },
      }),
    ).toBe(true);
    expect(
      Value.Check(HostReplySchema, {
        hostRequestId: "h1",
        kind: "host.reply",
        ok: false,
        code: "audit_failed",
      }),
    ).toBe(true);
    expect(
      Value.Check(HostReplySchema, {
        hostRequestId: "",
        kind: "host.reply",
        ok: true,
        payload: { acknowledged: true },
      }),
    ).toBe(false);
    expect(
      Value.Check(HostReplySchema, {
        hostRequestId: "h1",
        kind: "host.reply",
        ok: true,
        payload: { secret: "x" },
      }),
    ).toBe(false);
    expect(
      Value.Check(HostReplySchema, { hostRequestId: "h1", kind: "host.reply", ok: false }),
    ).toBe(false);
    expect(
      Value.Check(HostReplySchema, {
        hostRequestId: "h1",
        kind: "host.reply",
        ok: true,
        payload: { acknowledged: true },
        extra: 1,
      }),
    ).toBe(false);
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
