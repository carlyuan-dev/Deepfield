import { describe, expect, it, vi } from "vitest";
import type { AgentWorkerRequest, CompanyResearchWorkerEvent } from "@deepfield/contracts";
import type { ChatAgent } from "./message-loop.js";
import { createCompanyResearchAgent } from "./company-research-agent.js";
import { rawResearchRequest, structureResearchRequest } from "./company-research-test-helpers.js";

describe("generic company research agent", () => {
  it("runs raw research through standard web tools and streams the report", async () => {
    let received!: AgentWorkerRequest;
    const rawAgent: ChatAgent = { async run(request, emit) { received = request; emit({ requestId: request.requestId, type: "text_delta", delta: "报告 [来源](https://example.com)" }); emit({ requestId: request.requestId, type: "completed", text: "报告 [来源](https://example.com)" }); } };
    const events: CompanyResearchWorkerEvent[] = [];
    await createCompanyResearchAgent({ rawAgent }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
    expect(received.toolAccess).toMatchObject({ network: "enabled", maxSearchCalls: 8, maxFetchCalls: 8 });
    expect(received.context.systemPrompt).toContain("web_search 与 fetch_url");
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
});
