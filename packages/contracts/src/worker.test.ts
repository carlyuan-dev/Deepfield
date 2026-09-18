import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { AgentWorkerEventSchema, AgentWorkerRequestSchema } from "./chat.js";
import {
  CompanyResearchCancelRequestSchema,
  CompanyResearchWorkerEventSchema,
  CompanyResearchWorkerRequestSchema,
  CompanyResearchEventSchema,
  STRUCTURED_RESEARCH_OUTPUT_SCHEMA,
} from "./research.js";
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
  context: { conversationId: "c1", systemPrompt: "sys", messages: [] },
  options: { webSearch: false },
  llm: { id: "llm-1", name: "DeepSeek", provider: "deepseek", protocol: "openai_compatible", baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash", contextWindow: 128_000, apiKey: "sk-test-key" },
  toolAccess: { network: "disabled", maxAgentTurns: 6, maxSearchCalls: 0, maxFetchCalls: 0 },
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

const researchRequest = {
  requestId: "research-1", kind: "company-research.raw.run", runId: "run-1", stage: "raw",
  llm: { id: "llm-1", name: "DeepSeek", provider: "deepseek", protocol: "openai_compatible", baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash", contextWindow: 128_000, apiKey: "sk-test-key" },
  search: { id: "search-1", name: "Zhipu", provider: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", options: {}, apiKey: "search-test-key" },
  toolAccess: { network: "enabled", maxAgentTurns: 12, maxSearchCalls: 8, maxFetchCalls: 8 },
  context: { currentDate: "2026-09-11", companyName: "小米", topicName: "电池", direction: "product_and_technology", asOfDate: "2026-09-11" },
  template: {
    templateId: "product_and_technology", templateVersion: 1, title: "产品与技术",
    sections: ["products_and_positioning", "technology_and_metrics", "development_and_readiness", "competitive_position", "constraints_and_roadmap"].map((sectionId) => ({ sectionId, title: "模块", coreQuestion: "问题", coverage: "覆盖", boundary: "边界" })),
  },
};
const { search: _rawSearch, ...researchWithoutSearch } = researchRequest;
const structureRequest = {
  ...researchWithoutSearch,
  kind: "company-research.structure.run",
  stage: "structure",
  rawReportText: "# 原始报告",
  outputSchema: STRUCTURED_RESEARCH_OUTPUT_SCHEMA,
  toolAccess: { network: "disabled", maxAgentTurns: 1, maxSearchCalls: 0, maxFetchCalls: 0 },
};

describe("utility worker protocol", () => {
  it("accepts only fixed raw web search failure and a metadata-free public outcome", () => {
    const failure = { requestId: "request-1", runId: "run-1", stage: "raw", type: "failed", code: "web_search_failed", message: "company research web search failed" };
    expect(Value.Check(CompanyResearchWorkerEventSchema, failure)).toBe(true);
    expect(Value.Check(UtilityWorkerEventSchema, failure)).toBe(true);
    for (const invalid of [{ ...failure, stage: "structure" }, { ...failure, message: "private refusal" }, { ...failure, query: "private query" }, { ...failure, code: "provider_failure" }]) {
      expect(Value.Check(CompanyResearchWorkerEventSchema, invalid)).toBe(false);
    }
    const changed = { type: "state_changed", itemId: "item-1", companyId: "company-1", runId: "run-1", outcome: "web_search_failed" };
    expect(Value.Check(CompanyResearchEventSchema, changed)).toBe(true);
    expect(Value.Check(CompanyResearchEventSchema, { ...changed, message: "private refusal" })).toBe(false);
    expect(Value.Check(CompanyResearchEventSchema, { ...changed, outcome: "private refusal" })).toBe(false);
  });

  it("allows only strict conversation read RPC payloads and replies", () => {
    const requests = [
      { method: "conversation.listRecent", payload: { limit: 10 } },
      { method: "conversation.read", payload: { conversationId: "c1", limit: 40 } },
      { method: "conversation.search", payload: { query: "alpha", maxResults: 10 } },
    ].map((request, index) => ({
      hostRequestId: `conversation-${index}`,
      kind: "host.request",
      ...request,
    }));
    for (const request of requests) {
      expect(Value.Check(HostRequestSchema, request)).toBe(true);
      expect(Value.Check(HostRequestSchema, { ...request, payload: { ...request.payload, sql: "SELECT *" } })).toBe(false);
    }
    expect(
      Value.Check(HostRequestSchema, {
        ...requests[0],
        payload: { limit: 31 },
      }),
    ).toBe(false);
    expect(
      Value.Check(HostReplySchema, {
        hostRequestId: "conversation-0",
        kind: "host.reply",
        method: "conversation.listRecent",
        ok: true,
        payload: {
          conversations: [{ id: "c1", title: "Alpha", updatedAt: "2026-09-09T00:00:00.000Z" }],
        },
      }),
    ).toBe(true);
    expect(
      Value.Check(HostReplySchema, {
        hostRequestId: "conversation-1",
        kind: "host.reply",
        method: "conversation.read",
        ok: true,
        payload: { conversation: null, sql: "SELECT *" },
      }),
    ).toBe(false);
  });

  it("keeps chat requests valid and adds tool and research requests to the union", () => {
    const cancelRequest = {
      requestId: "research-1",
      kind: "company-research.cancel",
      runId: "run-1",
      stage: "raw",
    };
    expect(Value.Check(AgentWorkerRequestSchema, chatRequest)).toBe(true);
    expect(Value.Check(ToolRunRequestSchema, toolRequest)).toBe(true);
    expect(Value.Check(UtilityWorkerRequestSchema, chatRequest)).toBe(true);
    expect(Value.Check(UtilityWorkerRequestSchema, toolRequest)).toBe(true);
    expect(Value.Check(CompanyResearchWorkerRequestSchema, researchRequest)).toBe(true);
    expect(Value.Check(CompanyResearchCancelRequestSchema, cancelRequest)).toBe(true);
    expect(Value.Check(UtilityWorkerRequestSchema, researchRequest)).toBe(true);
    expect(Value.Check(UtilityWorkerRequestSchema, cancelRequest)).toBe(true);
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
    const researchEvent = { requestId: "research-1", runId: "run-1", stage: "raw", type: "started" };
    expect(Value.Check(AgentWorkerEventSchema, chatEvent)).toBe(true);
    expect(Value.Check(ToolExecutionEventSchema, toolEvent)).toBe(true);
    expect(Value.Check(UtilityWorkerEventSchema, chatEvent)).toBe(true);
    expect(Value.Check(ToolEventEnvelopeSchema, envelope)).toBe(true);
    expect(Value.Check(UtilityWorkerEventSchema, envelope)).toBe(true);
    expect(Value.Check(CompanyResearchWorkerEventSchema, researchEvent)).toBe(true);
    expect(Value.Check(UtilityWorkerEventSchema, researchEvent)).toBe(true);
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
    const base = { executionId: "e", traceId: "t", attempts: 1, budgetConsumed: true };
    expect(
      Value.Check(HostRequestSchema, {
        hostRequestId: "h1",
        kind: "host.request",
        method: "audit.finish",
        payload: { executionId: "e", traceId: "t", attempts: 1, status: "completed" },
      }),
    ).toBe(false);
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

  it.each([
    { status: "completed" },
    { status: "failed", errorCode: "timeout" },
    { status: "cancelled" },
  ])("rejects consumed budget without an attempt for $status audit.finish", (terminal) => {
    const request = (attempts: number, budgetConsumed: boolean) => ({
      hostRequestId: "h-consumption",
      kind: "host.request",
      method: "audit.finish",
      payload: {
        executionId: "e",
        traceId: "t",
        attempts,
        budgetConsumed,
        ...terminal,
      },
    });

    expect(Value.Check(HostRequestSchema, request(0, true))).toBe(false);
    expect(Value.Check(HostRequestSchema, request(1, false))).toBe(true);
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
        payload: { executionId: "e", traceId: "t", status: "failed", attempts: 2, budgetConsumed: true, errorCode: "rate_limited" },
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

describe("two-stage company research protocol", () => {
  it("freezes the complete exported output schema so mutation cannot alter accepted worker payloads", () => {
    const pending: unknown[] = [STRUCTURED_RESEARCH_OUTPUT_SCHEMA];
    while (pending.length > 0) {
      const value = pending.pop();
      if (value !== null && typeof value === "object") {
        expect(Object.isFrozen(value)).toBe(true);
        pending.push(...Object.values(value));
      }
    }
    const schema = STRUCTURED_RESEARCH_OUTPUT_SCHEMA as Record<string, unknown>;
    const properties = schema.properties as Record<string, { maxItems: number }>;
    const required = schema.required as string[];
    expect(Reflect.set(STRUCTURED_RESEARCH_OUTPUT_SCHEMA, "additionalProperties", true)).toBe(false);
    expect(Reflect.set(properties.coreSummary!, "maxItems", 100)).toBe(false);
    expect(Reflect.set(required, "0", "injectedField")).toBe(false);

    const structure = { ...structureRequest, outputSchema: JSON.parse(JSON.stringify(STRUCTURED_RESEARCH_OUTPUT_SCHEMA)) };
    expect(Value.Check(UtilityWorkerRequestSchema, structure)).toBe(true);
    structure.outputSchema.properties.coreSummary.maxItems = 100;
    expect(Value.Check(UtilityWorkerRequestSchema, structure)).toBe(false);
  });

  it("requires raw and structure kinds, stage identity, snapshots and the fixed output schema", () => {
    expect(Value.Check(CompanyResearchWorkerRequestSchema, researchRequest)).toBe(true);
    const structure = structureRequest;
    expect(Value.Check(UtilityWorkerRequestSchema, structure)).toBe(true);
    expect(Value.Check(UtilityWorkerRequestSchema, JSON.parse(JSON.stringify(structure)))).toBe(true);
    for (const invalid of [
      { ...researchRequest, kind: "company-research.run" }, { ...researchRequest, stage: "structure" },
      { ...structure, stage: "raw" }, { ...structure, rawReportText: "" },
      { ...structure, outputSchema: {} }, { ...structure, tools: ["web_search"] },
    ]) expect(Value.Check(UtilityWorkerRequestSchema, invalid)).toBe(false);
    for (const key of ["requestId", "runId", "stage", "context", "template", "rawReportText", "outputSchema"]) {
      const invalid = { ...structure };
      Reflect.deleteProperty(invalid, key);
      expect(Value.Check(UtilityWorkerRequestSchema, invalid)).toBe(false);
    }
  });

  it("only streams raw deltas and requires identity on every stage event and cancellation", () => {
    const identity = { requestId: "research-1", runId: "run-1" };
    const events = [
      { type: "started" }, { type: "completed", text: "complete candidate" }, { type: "cancelled" },
    ];
    for (const stage of ["raw", "structure"]) {
      const failure = stage === "raw"
        ? { type: "failed", code: "research_failed", message: "company research failed" }
        : { type: "failed", code: "structuring_failed", message: "company research structuring failed" };
      for (const event of [...events, failure]) {
        const valid = { ...identity, stage, ...event };
        expect(Value.Check(CompanyResearchWorkerEventSchema, valid)).toBe(true);
        expect(Value.Check(UtilityWorkerEventSchema, valid)).toBe(true);
        for (const key of ["requestId", "runId", "stage"]) {
          const invalid = { ...valid };
          Reflect.deleteProperty(invalid, key);
          expect(Value.Check(CompanyResearchWorkerEventSchema, invalid)).toBe(false);
          expect(Value.Check(UtilityWorkerEventSchema, invalid)).toBe(false);
        }
        expect(Value.Check(CompanyResearchWorkerEventSchema, { ...valid, apiKey: "secret" })).toBe(false);
      }
      const cancel = { ...identity, stage, kind: "company-research.cancel" };
      expect(Value.Check(UtilityWorkerRequestSchema, cancel)).toBe(true);
      Reflect.deleteProperty(cancel, "stage");
      expect(Value.Check(CompanyResearchCancelRequestSchema, cancel)).toBe(false);
    }
    expect(Value.Check(UtilityWorkerEventSchema, { ...identity, stage: "raw", type: "text_delta", delta: "draft" })).toBe(true);
    expect(Value.Check(UtilityWorkerEventSchema, { ...identity, stage: "structure", type: "text_delta", delta: "{unfinished" })).toBe(false);
    expect(Value.Check(CompanyResearchWorkerEventSchema, { ...identity, stage: "structure", type: "failed", code: "research_failed", message: "raw provider secret" })).toBe(false);
  });

  it("keeps application state changes separate from worker terminal events", () => {
    expect(CompanyResearchEventSchema).toBeDefined();
    const rawCompleted = { requestId: "research-1", runId: "run-1", stage: "raw", type: "completed", text: "# raw" };
    expect(Value.Check(CompanyResearchWorkerEventSchema, rawCompleted)).toBe(true);
    expect(Value.Check(CompanyResearchEventSchema, rawCompleted)).toBe(false);
    const changed = { type: "state_changed", itemId: "item-1", companyId: "company-1", runId: "run-1" };
    expect(Value.Check(CompanyResearchEventSchema, changed)).toBe(true);
    expect(Value.Check(UtilityWorkerEventSchema, changed)).toBe(false);
    expect(Value.Check(CompanyResearchEventSchema, { ...changed, apiKey: "secret" })).toBe(false);
    expect(Value.Check(CompanyResearchEventSchema, { requestId: "research-1", runId: "run-1", stage: "raw", type: "text_delta", delta: "draft" })).toBe(true);
    expect(Value.Check(CompanyResearchEventSchema, { ...rawCompleted, stage: "structure", text: "unvalidated JSON" })).toBe(false);
  });

  it("accepts research-scoped safe tool activity and fixed public failure categories", () => {
    const activity = {
      requestId: "research-1", runId: "run-1", stage: "raw", type: "tool_activity",
      callKey: "tool-1", name: "web_search", summary: "宇树科技", status: "running",
      agentTurnIndex: 1, budgetConsumed: true,
    };
    expect(Value.Check(CompanyResearchWorkerEventSchema, activity)).toBe(true);
    expect(Value.Check(CompanyResearchEventSchema, activity)).toBe(true);
    expect(Value.Check(CompanyResearchWorkerEventSchema, { ...activity, apiKey: "secret" })).toBe(false);
    for (const code of ["tool_failed", "model_failed", "empty_report", "protocol_leak", "language_validation_failed", "incomplete_response"]) {
      expect(Value.Check(CompanyResearchWorkerEventSchema, {
        requestId: "research-1", runId: "run-1", stage: "raw", type: "failed", code,
        message: "company research failed",
      })).toBe(true);
    }
  });

  it("accepts only bounded research model diagnostics without sensitive payload fields", () => {
    const diagnostic = {
      requestId: "research-1", runId: "run-1", traceId: "research-1", stage: "raw",
      type: "model_diagnostic", phase: "synthesizing", agentTurns: 12,
      searchCalls: 8, fetchCalls: 7, maxModelInputCharsEstimate: 12000, outputChars: 0,
      stopReason: "error", errorCategory: "invalid_final_empty",
      startedAt: "2026-09-15T08:00:00.000Z", finishedAt: "2026-09-15T08:00:10.000Z", durationMs: 10000,
    };
    expect(Value.Check(CompanyResearchWorkerEventSchema, diagnostic)).toBe(true);
    expect(Value.Check(CompanyResearchWorkerEventSchema, {
      ...diagnostic, stage: "structure", phase: "structuring", attempt: 1, errorCategory: "schema_invalid",
      validationIssues: [{ path: "/sections/0/status", expected: "enum", actual: "string" }], failedCandidate: "{bad}",
    })).toBe(true);
    expect(Value.Check(CompanyResearchWorkerEventSchema, { ...diagnostic, failedCandidate: "x".repeat(16_385) })).toBe(false);
    expect(Value.Check(CompanyResearchEventSchema, diagnostic)).toBe(false);
    for (const [key, value] of [["prompt", "private"], ["messages", []], ["apiKey", "secret"], ["errorMessage", "provider body"], ["url", "https://secret.test"]] as const) {
      expect(Value.Check(CompanyResearchWorkerEventSchema, { ...diagnostic, [key]: value })).toBe(false);
    }
  });
});
