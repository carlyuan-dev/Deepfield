import { describe, expect, it, vi } from "vitest";
import type { AgentWorkerRequest, CompanyResearchWorkerEvent } from "@deepfield/contracts";
import type { ChatAgent } from "./message-loop.js";
import { createCompanyResearchAgent } from "./company-research-agent.js";
import { rawResearchRequest, structureResearchRequest } from "./company-research-test-helpers.js";
import {
  agentEnd,
  assistant,
  assistantWithTool,
  FakePiAgent,
  makeRuntime,
  stubModel,
  textDelta,
} from "./pi-chat-agent-test-helpers.js";

describe("generic company research agent", () => {
  it("runs raw research through standard web tools and streams the report", async () => {
    let received!: AgentWorkerRequest;
    const rawAgent: ChatAgent = { async run(request, emit) { received = request; emit({ requestId: request.requestId, type: "text_delta", delta: "报告 [来源](https://example.com)" }); emit({ requestId: request.requestId, type: "completed", text: "报告 [来源](https://example.com)" }); } };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ rawAgent }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
    expect(received.toolAccess).toMatchObject({ network: "enabled", maxSearchCalls: 8, maxFetchCalls: 8 });
    expect(received.context.systemPrompt).toContain("web_search 与 read_webpage");
    expect(events.map((event) => event.type)).toEqual(["started", "text_delta", "completed"]);
  });

  it("structures in one no-tool model call without a Search snapshot", async () => {
    const completeText = vi.fn(async () => '{"coreSummary":[],"sections":[]}');
    const request = structureResearchRequest(); const events: CompanyResearchWorkerEvent[] = [];
    expect(request).not.toHaveProperty("search");
    await createCompanyResearchAgent({ gateway: { completeText } as never, rawAgent: {} as never }).run(request, (event) => events.push(event), new AbortController().signal);
    expect(completeText).toHaveBeenCalledWith(request.llm, expect.stringContaining("不能访问互联网"), expect.stringContaining(request.rawReportText), expect.any(AbortSignal));
    expect(events.map((event) => event.type)).toEqual(["started", "completed"]);
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
