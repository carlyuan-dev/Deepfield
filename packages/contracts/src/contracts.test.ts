import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  AgentWorkerRequestSchema,
  AgentWorkerEventSchema,
  CreateProjectInputSchema,
  DEFAULT_DEEPSEEK_MODEL_ID,
} from "./index.js";

describe("shared contracts", () => {
  it("accepts a required industry and optional structured scope", () => {
    expect(Value.Check(CreateProjectInputSchema, {
      industry: "人形机器人",
      scope: { focus: "整机与核心零部件", exclusions: ["工业机械臂"] },
      launchSource: "direct-ui",
    })).toBe(true);
    expect(Value.Check(CreateProjectInputSchema, { scope: {} })).toBe(false);
  });

  it("rejects malformed worker stream events", () => {
    expect(Value.Check(AgentWorkerEventSchema, {
      requestId: "req_1",
      type: "text_delta",
      delta: "你好",
    })).toBe(true);
    expect(Value.Check(AgentWorkerEventSchema, {
      requestId: "req_1",
      type: "text_delta",
    })).toBe(false);
  });
});

describe("agent worker request schema", () => {
  const validRequest = {
    requestId: "req_1",
    kind: "chat.prompt",
    prompt: "你好",
    context: {
      projectId: "project_1",
      conversationId: "conversation_1",
      systemPrompt: "你是 Deepfield 的主 Agent",
      messages: [
        { role: "user", content: "早上好", timestamp: 1700000000000 },
        { role: "assistant", content: "你好", timestamp: 1700000001000 },
      ],
    },
    apiKey: "sk-test-only",
    modelId: DEFAULT_DEEPSEEK_MODEL_ID,
  } as const;

  it("accepts a valid worker request with strict nested messages", () => {
    expect(Value.Check(AgentWorkerRequestSchema, validRequest)).toBe(true);
  });

  it("rejects malformed requests", () => {
    expect(Value.Check(AgentWorkerRequestSchema, { ...validRequest, kind: "other" })).toBe(false);
    expect(Value.Check(AgentWorkerRequestSchema, { ...validRequest, modelId: "gpt-4" })).toBe(false);
  });

  it("rejects extra fields at every object level", () => {
    expect(Value.Check(AgentWorkerRequestSchema, { ...validRequest, extra: 1 })).toBe(false);
    expect(
      Value.Check(AgentWorkerRequestSchema, {
        ...validRequest,
        context: { ...validRequest.context, extra: true },
      }),
    ).toBe(false);
    expect(
      Value.Check(AgentWorkerRequestSchema, {
        ...validRequest,
        context: {
          ...validRequest.context,
          messages: [
            ...validRequest.context.messages,
            { role: "user", content: "x", timestamp: 1, extra: 1 },
          ],
        },
      }),
    ).toBe(false);
  });

  it("rejects malformed nested messages", () => {
    expect(
      Value.Check(AgentWorkerRequestSchema, {
        ...validRequest,
        context: {
          ...validRequest.context,
          messages: [{ role: "system", content: "x", timestamp: 1 }],
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(AgentWorkerRequestSchema, {
        ...validRequest,
        context: {
          ...validRequest.context,
          messages: [{ role: "user", content: "x" }],
        },
      }),
    ).toBe(false);
  });

  it("rejects worker events with extra fields", () => {
    expect(Value.Check(AgentWorkerEventSchema, { requestId: "r", type: "started", extra: 1 })).toBe(false);
    expect(Value.Check(AgentWorkerEventSchema, { requestId: "r", type: "text_delta", delta: "d", extra: 1 })).toBe(false);
    expect(Value.Check(AgentWorkerEventSchema, { requestId: "r", type: "completed", text: "t", extra: 1 })).toBe(false);
    expect(Value.Check(AgentWorkerEventSchema, { requestId: "r", type: "failed", code: "c", message: "m", extra: 1 })).toBe(false);
  });

  it("exports the fixed deepseek model id", () => {
    expect(DEFAULT_DEEPSEEK_MODEL_ID).toBe("deepseek-v4-flash");
  });

  it("locks the request model id to the fixed deepseek model", () => {
    expect(
      Value.Check(AgentWorkerRequestSchema, { ...validRequest, modelId: "deepseek-v4-flash" }),
    ).toBe(true);
    expect(
      Value.Check(AgentWorkerRequestSchema, { ...validRequest, modelId: "deepseek-v4-pro" }),
    ).toBe(false);
    const literal = (
      AgentWorkerRequestSchema as unknown as {
        properties: { modelId: { const?: string } };
      }
    ).properties.modelId;
    expect(literal.const).toBe(DEFAULT_DEEPSEEK_MODEL_ID);
  });
});
