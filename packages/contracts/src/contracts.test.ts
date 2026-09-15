import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  AgentWorkerRequestSchema,
  AgentWorkerEventSchema,
  CompanyDraftSchema,
  CreateIndustryResearchItemInputSchema,
  DEFAULT_DEEPSEEK_MODEL_ID,
  HostRequestSchema,
  SkillSummarySchema,
} from "./index.js";

describe("shared contracts", () => {
  it("accepts closed research item and company inputs", () => {
    expect(Value.Check(CreateIndustryResearchItemInputSchema, {
      industry: "人形机器人",
      researchScope: "整机与核心零部件",
      notes: "重点关注上市公司",
    })).toBe(true);
    expect(Value.Check(CreateIndustryResearchItemInputSchema, { industry: "x", extra: true })).toBe(false);
    expect(Value.Check(CompanyDraftSchema, { name: "公司甲", note: "候选" })).toBe(true);
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
      conversationId: "conversation_1",
      systemPrompt: "你是 Deepfield 的主 Agent",
      messages: [
        { role: "user", content: "早上好", timestamp: 1700000000000 },
        { role: "assistant", content: "你好", timestamp: 1700000001000 },
      ],
    },
    options: { webSearch: false },
    llm: {
      id: "llm-1",
      name: "DeepSeek",
      provider: "deepseek",
      protocol: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      modelId: DEFAULT_DEEPSEEK_MODEL_ID,
      contextWindow: 128_000,
      apiKey: "sk-test-only",
    },
    toolAccess: { network: "disabled", maxAgentTurns: 6, maxSearchCalls: 0, maxFetchCalls: 0 },
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

  it("accepts batch-scoped skipped and reused tool activity without claiming budget consumption", () => {
    const skipped = {
      requestId: "req-1",
      type: "tool_activity",
      callKey: "call-5",
      name: "web_search",
      status: "skipped",
      errorCode: "budget_trimmed",
      agentTurnIndex: 2,
      batchId: "batch-2",
      toolCallId: "call-5",
      budgetConsumed: false,
    } as const;
    expect(Value.Check(AgentWorkerEventSchema, skipped)).toBe(true);
    expect(
      Value.Check(AgentWorkerEventSchema, {
        requestId: "req-1",
        type: "tool_activity",
        callKey: "call-6",
        name: "web_search",
        toolCallId: "call-6",
        status: "reused",
        agentTurnIndex: 2,
        batchId: "batch-2",
        budgetConsumed: false,
      }),
    ).toBe(true);
    expect(Value.Check(AgentWorkerEventSchema, { ...skipped, budgetConsumed: true })).toBe(false);
  });

  it("accepts only truthful terminal records on the dedicated synthetic audit RPC", () => {
    const request = {
      hostRequestId: "host-1",
      kind: "host.request",
      method: "audit.synthetic",
      payload: {
        executionId: "skip-1",
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
      },
    } as const;
    expect(Value.Check(HostRequestSchema, request)).toBe(true);
    expect(Value.Check(HostRequestSchema, { ...request, payload: { ...request.payload, attempts: 1 } })).toBe(false);
    expect(Value.Check(HostRequestSchema, { ...request, payload: { ...request.payload, budgetConsumed: true } })).toBe(false);
    expect(Value.Check(HostRequestSchema, { ...request, payload: { ...request.payload, errorCode: "timeout" } })).toBe(false);
    expect(Value.Check(HostRequestSchema, {
      ...request,
      payload: {
        ...request.payload,
        executionId: "invalid-1",
        status: "failed",
        errorCode: "invalid_input",
      },
    })).toBe(true);
    expect(Value.Check(HostRequestSchema, {
      ...request,
      payload: { ...request.payload, status: "failed", errorCode: "timeout" },
    })).toBe(false);
  });

  it("exports the fixed deepseek model id", () => {
    expect(DEFAULT_DEEPSEEK_MODEL_ID).toBe("deepseek-v4-flash");
  });

  it("accepts configured model ids and rejects malformed model snapshots", () => {
    expect(
      Value.Check(AgentWorkerRequestSchema, {
        ...validRequest,
        llm: { ...validRequest.llm, modelId: "qwen-max" },
      }),
    ).toBe(true);
    expect(
      Value.Check(AgentWorkerRequestSchema, {
        ...validRequest,
        llm: { ...validRequest.llm, baseUrl: "http://insecure.test" },
      }),
    ).toBe(false);
  });

  describe("chat request options and skill summaries", () => {
    it("accepts chat request options with an optional non-blank skill name", () => {
      expect(
        Value.Check(AgentWorkerRequestSchema, {
          ...validRequest,
          options: { webSearch: false, skillName: "structured-brief" },
        }),
      ).toBe(true);
      expect(
        Value.Check(AgentWorkerRequestSchema, { ...validRequest, options: { webSearch: true } }),
      ).toBe(true);
    });

    it("rejects malformed chat request options", () => {
      expect(
        Value.Check(AgentWorkerRequestSchema, { ...validRequest, options: {} }),
      ).toBe(false);
      expect(
        Value.Check(AgentWorkerRequestSchema, {
          ...validRequest,
          options: { webSearch: false, skillName: "" },
        }),
      ).toBe(false);
      expect(
        Value.Check(AgentWorkerRequestSchema, {
          ...validRequest,
          options: { skillName: "structured-brief" },
        }),
      ).toBe(false);
      expect(
        Value.Check(AgentWorkerRequestSchema, {
          ...validRequest,
          options: { webSearch: false, extra: 1 },
        }),
      ).toBe(false);
      expect(
        Value.Check(AgentWorkerRequestSchema, {
          requestId: "req",
          kind: "chat.prompt",
          prompt: "p",
          context: validRequest.context,
        }),
      ).toBe(false);
    });

    it("accepts started events with an optional skill name and rejects extras", () => {
      expect(Value.Check(AgentWorkerEventSchema, { requestId: "r", type: "started" })).toBe(true);
      expect(
        Value.Check(AgentWorkerEventSchema, {
          requestId: "r",
          type: "started",
          skillName: "structured-brief",
        }),
      ).toBe(true);
      expect(
        Value.Check(AgentWorkerEventSchema, {
          requestId: "r",
          type: "started",
          skillName: "",
        }),
      ).toBe(false);
      expect(
        Value.Check(AgentWorkerEventSchema, {
          requestId: "r",
          type: "started",
          skillName: "x",
          extra: 1,
        }),
      ).toBe(false);
    });

    it("validates the SkillSummary schema strictly", () => {
      expect(Value.Check(SkillSummarySchema, { name: "a", description: "d" })).toBe(true);
      expect(Value.Check(SkillSummarySchema, { name: "", description: "d" })).toBe(false);
      expect(Value.Check(SkillSummarySchema, { name: "a", description: "d", content: "x" })).toBe(
        false,
      );
      expect(Value.Check(SkillSummarySchema, { name: "a" })).toBe(false);
    });
  });
});
