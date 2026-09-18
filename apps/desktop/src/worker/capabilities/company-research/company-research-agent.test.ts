import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentWorkerRequest, CompanyResearchWorkerEvent } from "@deepfield/contracts";
import type { ToolBudgetSnapshot } from "@deepfield/tool-platform";
import type { ChatAgent } from "../../message-loop.js";
import { createCompanyResearchAgent } from "./company-research-agent.js";
import { PiChatAgentError } from "../../agent/pi-chat-agent.js";
import { rawResearchRequest, structureResearchRequest } from "./company-research-test-helpers.js";
import {
  agentEnd,
  assistant,
  assistantWithTool,
  FakePiAgent,
  makeInstalledPiRuntime,
  makeRecordingInstalledPiRuntime,
  makeRuntime,
  stubModel,
  textDelta,
} from "../../agent/pi-chat-agent-test-helpers.js";

function validStructuredCandidate() {
  return {
    coreSummary: ["现有公开信息不足以形成可靠的核心判断。"],
    sections: structureResearchRequest().template.sections.map(({ sectionId }) => ({ sectionId, status: "not_found", summary: null, facts: [] })),
  };
}

const budgetSnapshot = (
  searchLimit: number,
  fetchLimit: number,
  searchRemaining: number,
  fetchRemaining: number,
): ToolBudgetSnapshot => ({
  total: {
    limit: searchLimit + fetchLimit,
    reserved: 0,
    consumed: searchLimit + fetchLimit - searchRemaining - fetchRemaining,
    remaining: searchRemaining + fetchRemaining,
    exhausted: searchRemaining + fetchRemaining === 0,
  },
  categories: {
    search: {
      limit: searchLimit,
      reserved: 0,
      consumed: searchLimit - searchRemaining,
      remaining: searchRemaining,
      exhausted: searchRemaining === 0,
    },
    fetch: {
      limit: fetchLimit,
      reserved: 0,
      consumed: fetchLimit - fetchRemaining,
      remaining: fetchRemaining,
      exhausted: fetchRemaining === 0,
    },
    link_check: { reserved: 0, consumed: 0, exhausted: false },
    parse: { reserved: 0, consumed: 0, exhausted: false },
    none: { reserved: 0, consumed: 0, exhausted: false },
  },
});

function makeResearchToolSessions(
  searchLimit: number,
  fetchLimit: number,
  failedFetchCallId?: string,
) {
  let searchRemaining = searchLimit;
  let fetchRemaining = fetchLimit;
  return {
    createAgentTools: () => [
      {
        name: "web_search",
        description: "search",
        label: "search",
        parameters: Type.Object({ query: Type.String() }),
        async execute(toolCallId: string) {
          searchRemaining -= 1;
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                results: [{
                  title: `证据 ${toolCallId}`,
                  url: `https://evidence.test/${toolCallId}`,
                  snippet: `公开资料 ${toolCallId}`,
                }],
              }),
            }],
            details: {},
          };
        },
      },
      {
        name: "read_webpage",
        description: "fetch",
        label: "fetch",
        parameters: Type.Object({ url: Type.String() }),
        async execute(toolCallId: string, params: unknown) {
          fetchRemaining -= 1;
          if (toolCallId === failedFetchCallId) {
            throw new Error(
              `tool_failed ${JSON.stringify({
                code: "timeout",
                message: "末次网页读取超时",
                retryable: false,
                attempts: 1,
                budgetConsumed: true,
              })}`,
            );
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ url: params, text: `网页正文 ${toolCallId}` }),
            }],
            details: {},
          };
        },
      },
    ],
    bindSearchProvider: () => undefined,
    budgetSnapshot: () => budgetSnapshot(
      searchLimit,
      fetchLimit,
      searchRemaining,
      fetchRemaining,
    ),
    recordSynthetic: async () => undefined,
    releaseTrace: () => true,
  };
}

function toolTurn(calls: AssistantMessage["content"]): AssistantMessage {
  return assistant("", { content: calls, stopReason: "toolUse" });
}

describe("generic company research agent", () => {
  it.each(["natural_stop", "budget_exhausted"] as const)(
    "keeps research requirements but removes exploration instructions from %s finalization",
    async (reason) => {
      const request = rawResearchRequest();
      request.toolAccess = {
        network: "enabled", maxAgentTurns: 12, maxSearchCalls: 1,
        maxFetchCalls: reason === "natural_stop" ? 2 : 1,
      };
      const report = "# 公司关键调研原始报告\n\n截至2026-06-30，研究范围为 Humanoid actuators；现有网页正文支持有限事实，尚未确认的内容保留为模块缺口。";
      const recording = makeRecordingInstalledPiRuntime([
        toolTurn([{ type: "toolCall", id: "source-search", name: "web_search", arguments: { query: "Humanoid actuators" } }]),
        toolTurn([{ type: "toolCall", id: "source-fetch", name: "read_webpage", arguments: { url: "https://evidence.test/source-search" } }]),
        ...(reason === "natural_stop" ? [assistant("现有资料已足够成稿。")] : []),
        (context) => {
          const instructions = context.systemPrompt ?? "";
          const input = JSON.stringify(context.messages);
          if (/必须使用网页搜索|web_search|read_webpage|再自主搜索|按需要执行多次搜索/u.test(instructions)) {
            return toolTurn([{ type: "toolCall", id: "leaked-exploration", name: "web_search", arguments: { query: "follow leaked instruction" } }]);
          }
          const preservesRequirements =
            instructions.includes("只研究目标公司、唯一研究方向及所选五个模块") &&
            instructions.includes("不采纳截止日期之后才公开的信息") &&
            instructions.includes("固定 Markdown 标题和顺序") &&
            instructions.includes("每条事实必须紧跟一个且仅一个") &&
            input.includes("Humanoid actuators") && input.includes("2026-06-30") &&
            input.includes("# 公司关键调研原始报告") && input.includes("### 模块缺口") &&
            input.includes("网页正文 source-fetch");
          return assistant(preservesRequirements ? report : "Research requirements or evidence were lost.");
        },
      ]);
      const events: CompanyResearchWorkerEvent[] = [];

      await createCompanyResearchAgent({
        piRuntime: recording.runtime,
        toolSessions: makeResearchToolSessions(1, request.toolAccess.maxFetchCalls),
      }).run(request, (event) => events.push(event), new AbortController().signal);

      expect(events.at(-1)).toMatchObject({ type: "completed", stage: "raw", text: report });
      expect(events.some((event) => event.type === "failed")).toBe(false);
      expect(recording.requests).toHaveLength(reason === "natural_stop" ? 4 : 3);
      expect(recording.requests[0]?.systemPrompt).toContain("必须使用网页搜索");
      const finalRequest = recording.requests.at(-1);
      expect(finalRequest?.systemPrompt).not.toMatch(/必须使用网页搜索|web_search|read_webpage/u);
      expect(finalRequest?.tools).toEqual([]);
      expect(finalRequest?.toolChoice).toBe("none");
    },
  );

  it("returns one legal raw report after exactly eight searches and eight webpage reads", async () => {
    const searchTurns = Array.from({ length: 4 }, (_, turn) => toolTurn(
      Array.from({ length: 2 }, (_unused, slot) => {
        const index = turn * 2 + slot + 1;
        return {
          type: "toolCall" as const,
          id: `search-${index}`,
          name: "web_search",
          arguments: { query: `宇树科技证据 ${index}` },
        };
      }),
    ));
    const fetchTurns = Array.from({ length: 4 }, (_, turn) => toolTurn(
      Array.from({ length: 2 }, (_unused, slot) => {
        const index = turn * 2 + slot + 1;
        return {
          type: "toolCall" as const,
          id: `fetch-${index}`,
          name: "read_webpage",
          arguments: { url: `https://evidence.test/search-${index}` },
        };
      }),
    ));
    const rawReport = "# 宇树科技调研报告\n\n基于公开资料，公司持续推进人形机器人商业化。[来源](https://evidence.test/search-1)";
    const runtime = makeInstalledPiRuntime([
      ...searchTurns,
      ...fetchTurns,
      assistant(rawReport),
    ]);
    const toolSessions = makeResearchToolSessions(8, 8);
    const events: CompanyResearchWorkerEvent[] = [];

    await createCompanyResearchAgent({ piRuntime: runtime, toolSessions }).run(
      rawResearchRequest(),
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(events.filter((event) => event.type === "tool_activity" && event.name === "web_search" && event.status === "completed")).toHaveLength(8);
    expect(events.filter((event) => event.type === "tool_activity" && event.name === "read_webpage" && event.status === "completed")).toHaveLength(8);
    expect(events.flatMap((event) =>
      event.type === "tool_activity" && event.name === "research_synthesis" ? [event.status] : []
    )).toEqual(["running", "completed"]);
    const synthesisStartedAt = events.findIndex((event) => event.type === "tool_activity" && event.name === "research_synthesis");
    expect(events.slice(synthesisStartedAt + 1).some((event) =>
      event.type === "tool_activity" && (event.name === "web_search" || event.name === "read_webpage")
    )).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "completed", stage: "raw", text: rawReport });
  });

  it("uses existing evidence to complete the raw report when the final tool fails", async () => {
    const search = toolTurn([{
      type: "toolCall",
      id: "search-1",
      name: "web_search",
      arguments: { query: "宇树科技商业化" },
    }]);
    const finalFetch = toolTurn([{
      type: "toolCall",
      id: "fetch-last",
      name: "read_webpage",
      arguments: { url: "https://evidence.test/search-1" },
    }]);
    const rawReport = "# 宇树科技调研报告\n\n前序成功证据为“公开资料 search-1”；末次失败事实为“末次网页读取超时”，相关网页细节仍待确认。";
    const runtime = makeInstalledPiRuntime([
      search,
      finalFetch,
      (context) => {
        const finalizationEvidence = JSON.stringify(context.messages);
        return assistant(
          finalizationEvidence.includes("公开资料 search-1") &&
            finalizationEvidence.includes("末次网页读取超时")
            ? rawReport
            : "Evidence was not preserved.",
        );
      },
    ]);
    const toolSessions = makeResearchToolSessions(1, 1, "fetch-last");
    const request = rawResearchRequest();
    request.toolAccess = {
      network: "enabled",
      maxAgentTurns: 12,
      maxSearchCalls: 1,
      maxFetchCalls: 1,
    };
    const events: CompanyResearchWorkerEvent[] = [];

    await createCompanyResearchAgent({ piRuntime: runtime, toolSessions }).run(
      request,
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_activity",
      name: "read_webpage",
      toolCallId: "fetch-last",
      status: "failed",
      errorCode: "timeout",
    }));
    expect(events.flatMap((event) =>
      event.type === "tool_activity" && event.name === "research_synthesis" ? [event.status] : []
    )).toEqual(["running", "completed"]);
    expect(events.at(-1)).toMatchObject({ type: "completed", stage: "raw", text: rawReport });
  });

  it("rejects a protocol-marked finalization instead of returning a polluted raw report", async () => {
    const runtime = makeInstalledPiRuntime([
      assistant("资料已足够，可以开始成稿。"),
      assistant("<｜｜DSML｜｜ calls>private</｜｜DSML｜｜ calls>"),
    ]);
    const toolSessions = makeResearchToolSessions(8, 8);
    const events: CompanyResearchWorkerEvent[] = [];

    await createCompanyResearchAgent({ piRuntime: runtime, toolSessions }).run(
      rawResearchRequest(),
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(events.filter((event) => event.type === "tool_activity" && event.name === "research_synthesis" && event.status === "running")).toHaveLength(1);
    expect(events.some((event) => event.type === "completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "failed", stage: "raw", code: "protocol_leak" });
  });

  it("runs raw research through standard web tools and streams the report", async () => {
    let received!: AgentWorkerRequest;
    const rawAgent: ChatAgent = { async run(request, emit) { received = request; emit({ requestId: request.requestId, type: "text_delta", delta: "报告 [来源](https://example.com)" }); emit({ requestId: request.requestId, type: "completed", text: "报告 [来源](https://example.com)" }); } };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ rawAgent }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
    expect(received.toolAccess).toMatchObject({ network: "enabled", maxSearchCalls: 8, maxFetchCalls: 8 });
    expect(received.context.systemPrompt).toContain("web_search 与 read_webpage");
    expect(events.map((event) => event.type)).toEqual(["started", "text_delta", "completed"]);
  });

  it("uses completion text as the canonical report while keeping deltas as preview only", async () => {
    const rawAgent: ChatAgent = { async run(request, emit) {
      emit({ requestId: request.requestId, type: "started" });
      emit({ requestId: request.requestId, type: "text_delta", delta: "预览草稿" });
      emit({ requestId: request.requestId, type: "completed", text: "最终报告" });
    } };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ rawAgent }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "预览草稿" }));
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "最终报告" });
  });

  it("accepts completion-only raw output", async () => {
    const rawAgent: ChatAgent = { async run(request, emit) {
      emit({ requestId: request.requestId, type: "started" });
      emit({ requestId: request.requestId, type: "completed", text: "最终报告" });
    } };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ rawAgent }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
    expect(events.at(-1)).toMatchObject({ type: "completed", text: "最终报告" });
  });

  it("rejects a delta-only run without a terminal event", async () => {
    const rawAgent: ChatAgent = { async run(request, emit) {
      emit({ requestId: request.requestId, type: "text_delta", delta: "看似完整的草稿" });
    } };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ rawAgent }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "incomplete_response" });
  });

  it("forwards safe tool activity with research identity and classifies protocol leakage", async () => {
    const rawAgent: ChatAgent = { async run(request, emit) {
      emit({ requestId: request.requestId, type: "tool_activity", callKey: "tool-1", name: "web_search", summary: "宇树科技", status: "completed", budgetConsumed: true });
      emit({ requestId: request.requestId, type: "completed", text: '<｜｜DSML｜｜ calls>private</｜｜DSML｜｜ calls>' });
    } };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ rawAgent }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_activity", stage: "raw", callKey: "tool-1", summary: "宇树科技" }));
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "protocol_leak" });
  });

  it("does not misclassify a later model failure because an earlier tool failed", async () => {
    const rawAgent: ChatAgent = { async run(request, emit) {
      emit({ requestId: request.requestId, type: "tool_activity", callKey: "tool-1", name: "read_webpage", status: "failed", errorCode: "unsupported_content_type" });
      emit({ requestId: request.requestId, type: "failed", code: "agent_error", message: "agent execution failed" });
    } };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ rawAgent }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "model_failed" });
  });

  it("does not misclassify a missing terminal because an earlier tool failed", async () => {
    const rawAgent: ChatAgent = { async run(request, emit) {
      emit({ requestId: request.requestId, type: "tool_activity", callKey: "tool-1", name: "read_webpage", status: "failed", errorCode: "unsupported_content_type" });
    } };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ rawAgent }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "incomplete_response" });
  });

  it.each([
    ["provider_failed", "model_failed"],
    ["stream_failed", "model_failed"],
    ["incomplete_lifecycle", "incomplete_response"],
    ["invalid_final_empty", "empty_report"],
    ["invalid_final_protocol", "protocol_leak"],
    ["invalid_final_language", "language_validation_failed"],
    ["invalid_final_tool_use", "incomplete_response"],
  ] as const)("maps Pi %s to safe research failure %s", async (piCode, researchCode) => {
    const rawAgent: ChatAgent = { async run() { throw new PiChatAgentError(piCode, "sanitized"); } };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ rawAgent }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
    expect(events.at(-1)).toMatchObject({ type: "failed", code: researchCode });
  });

  it.each([
    ["", "empty_report", "invalid_final_empty"],
    ["<｜｜DSML｜｜ calls>private</｜｜DSML｜｜ calls>", "protocol_leak", "invalid_final_protocol"],
    ["English only", "language_validation_failed", "invalid_final_language"],
  ] as const)("makes default Pi validation %s reachable as %s", async (text, researchCode, diagnosticCode) => {
    const answer = assistant(text);
    const fake = new FakePiAgent({ events: [{ type: "agent_start" }, agentEnd([answer])] });
    const request = rawResearchRequest();
    request.toolAccess = { network: "disabled", maxAgentTurns: 12, maxSearchCalls: 0, maxFetchCalls: 0 };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ piRuntime: makeRuntime(fake, stubModel) }).run(request, (event) => events.push(event), new AbortController().signal);
    expect(events).toContainEqual(expect.objectContaining({ type: "model_diagnostic", runId: request.runId, errorCategory: diagnosticCode }));
    expect(events.at(-1)).toMatchObject({ type: "failed", code: researchCode });
  });

  it("structures in one no-tool model call without a Search snapshot", async () => {
    const completeText = vi.fn(async () => JSON.stringify(validStructuredCandidate()));
    const request = structureResearchRequest(); const events: CompanyResearchWorkerEvent[] = [];
    expect(request).not.toHaveProperty("search");
    await createCompanyResearchAgent({ gateway: { completeText } as never, rawAgent: {} as never }).run(request, (event) => events.push(event), new AbortController().signal);
    expect(completeText).toHaveBeenCalledWith(request.llm, expect.stringContaining("不能访问互联网"), expect.stringContaining(request.rawReportText), expect.any(AbortSignal));
    expect(events.map((event) => event.type)).toEqual(["started", "model_diagnostic", "completed"]);
    expect(events[1]).toMatchObject({ phase: "structuring", searchCalls: 0, fetchCalls: 0, stopReason: "stop" });
  });

  it("classifies an empty structure completion without calling it a provider failure", async () => {
    const request = structureResearchRequest();
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({
      gateway: { completeText: vi.fn(async () => "") } as never,
      rawAgent: {} as never,
    }).run(request, (event) => events.push(event), new AbortController().signal);

    expect(events).toContainEqual(expect.objectContaining({
      type: "model_diagnostic",
      phase: "structuring",
      stopReason: "stop",
      errorCategory: "invalid_final_empty",
      outputChars: 0,
    }));
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "structuring_failed" });
  });

  it("records the failed JSON candidate and makes exactly one format-only repair attempt", async () => {
    const completeText = vi.fn()
      .mockResolvedValueOnce('{"coreSummary": [}')
      .mockResolvedValueOnce(JSON.stringify(validStructuredCandidate()));
    const request = structureResearchRequest(); const events: CompanyResearchWorkerEvent[] = [];

    await createCompanyResearchAgent({ gateway: { completeText } as never }).run(request, (event) => events.push(event), new AbortController().signal);

    expect(completeText).toHaveBeenCalledTimes(2);
    expect(completeText.mock.calls[1]?.[1]).toContain("格式修复");
    expect(completeText.mock.calls[1]?.[2]).toContain(request.rawReportText);
    expect(events.filter((event) => event.type === "model_diagnostic")).toEqual([
      expect.objectContaining({ attempt: 1, errorCategory: "json_parse", failedCandidate: '{"coreSummary": [}' }),
      expect.objectContaining({ attempt: 2, stopReason: "stop" }),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "completed", text: JSON.stringify(validStructuredCandidate()) });
  });

  it("persists real length truncation and never repairs it as malformed JSON", async () => {
    const completeTextResult = vi.fn(async () => ({ text: '{"coreSummary": [', stopReason: "length" as const }));
    const completeText = vi.fn();
    const request = structureResearchRequest(); const events: CompanyResearchWorkerEvent[] = [];

    await createCompanyResearchAgent({ gateway: { completeText, completeTextResult } as never }).run(request, (event) => events.push(event), new AbortController().signal);

    expect(completeTextResult).toHaveBeenCalledOnce();
    expect(completeText).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: "model_diagnostic", attempt: 1, stopReason: "length", errorCategory: "truncated", failedCandidate: '{"coreSummary": [' }));
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "structuring_failed" });
  });

  it("preserves cancellation while the single format repair is in flight", async () => {
    let rejectRepair!: (error: Error) => void;
    const completeText = vi.fn()
      .mockResolvedValueOnce("{broken")
      .mockImplementationOnce(() => new Promise<string>((_resolve, reject) => { rejectRepair = reject; }));
    const request = structureResearchRequest(); const events: CompanyResearchWorkerEvent[] = [];
    const controller = new AbortController();
    const run = createCompanyResearchAgent({ gateway: { completeText } as never }).run(request, (event) => events.push(event), controller.signal);
    await vi.waitFor(() => expect(completeText).toHaveBeenCalledTimes(2));
    controller.abort();
    rejectRepair(new Error("provider body remains private"));
    await run;

    expect(events).toContainEqual(expect.objectContaining({ type: "model_diagnostic", attempt: 2, stopReason: "aborted" }));
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
  });

  it("records a mid-flight structure cancellation as aborted without provider failure", async () => {
    let rejectCompletion!: (error: Error) => void;
    const completeText = vi.fn(() => new Promise<string>((_resolve, reject) => {
      rejectCompletion = reject;
    }));
    const request = structureResearchRequest();
    const events: CompanyResearchWorkerEvent[] = [];
    const controller = new AbortController();
    const run = createCompanyResearchAgent({ gateway: { completeText } as never, rawAgent: {} as never })
      .run(request, (event) => events.push(event), controller.signal);
    await vi.waitFor(() => expect(completeText).toHaveBeenCalledOnce());
    controller.abort();
    rejectCompletion(new Error("provider body must stay private"));
    await run;

    const diagnostic = events.find((event) => event.type === "model_diagnostic");
    expect(diagnostic).toMatchObject({ stopReason: "aborted" });
    expect(diagnostic).not.toHaveProperty("errorCategory");
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
  });

  it("records a mid-flight raw cancellation as aborted without provider failure", async () => {
    const fake = new FakePiAgent({ events: [], pending: true });
    const request = rawResearchRequest();
    request.toolAccess = {
      network: "disabled",
      maxAgentTurns: 12,
      maxSearchCalls: 0,
      maxFetchCalls: 0,
    };
    const events: CompanyResearchWorkerEvent[] = [];
    const controller = new AbortController();
    const run = createCompanyResearchAgent({ piRuntime: makeRuntime(fake, stubModel) })
      .run(request, (event) => events.push(event), controller.signal);
    await vi.waitFor(() => expect(fake.promptCallCount).toBe(1));
    controller.abort();
    await run;

    const diagnostic = events.find((event) => event.type === "model_diagnostic");
    expect(diagnostic).toMatchObject({ stopReason: "aborted" });
    expect(diagnostic).not.toHaveProperty("errorCategory");
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
  });

  it("keeps Chat-only formatting policy out of capability normal, retry, and synthesis prompts", async () => {
    const answer = assistant("研究完成");
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        textDelta("研究完成"),
        { type: "message_end", message: answer },
        agentEnd([answer]),
      ],
    });
    const request = rawResearchRequest();
    request.toolAccess = {
      network: "disabled",
      maxAgentTurns: 12,
      maxSearchCalls: 0,
      maxFetchCalls: 0,
    };
    const events: CompanyResearchWorkerEvent[] = [];

    await createCompanyResearchAgent({ piRuntime: makeRuntime(fake, stubModel) }).run(
      request,
      (event) => events.push(event),
      new AbortController().signal,
    );

    const options = fake.receivedOptions;
    expect(options?.initialState?.systemPrompt).toContain("company-research-raw-v1");
    expect(options?.initialState?.systemPrompt).not.toContain("优先使用简洁段落和必要的列表");

    const toolTurn = assistantWithTool("继续搜索");
    const retryUpdate = await options?.prepareNextTurnWithContext?.({
      message: toolTurn,
      toolResults: [],
      context: { systemPrompt: "原始系统提示", model: stubModel, messages: [], tools: [] },
      newMessages: [toolTurn],
    } as never);
    expect(retryUpdate?.context?.systemPrompt).not.toContain("优先使用简洁段落和必要的列表");

    const elevenAssistantTurns = Array.from({ length: 11 }, () => assistant("过程"));
    const synthesisUpdate = await options?.prepareNextTurnWithContext?.({
      message: toolTurn,
      toolResults: [],
      context: { systemPrompt: "原始系统提示", model: stubModel, messages: [], tools: [] },
      newMessages: elevenAssistantTurns,
    } as never);
    expect(synthesisUpdate?.context?.systemPrompt).not.toContain("优先使用简洁段落和必要的列表");
    expect(synthesisUpdate?.context?.systemPrompt).toContain("工具阶段已结束");
    expect(events.at(-1)?.type).toBe("completed");
  });
});
