import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DEEPSEEK_MODEL_ID,
  type CompanyResearchWorkerEvent,
  type CompanyResearchWorkerRequest,
  type ResearchRunId,
} from "@deepfield/contracts";
import {
  createCompanyResearchAgent,
} from "./company-research-agent.js";

function request(): CompanyResearchWorkerRequest {
  return {
    requestId: "research-request-1",
    kind: "company-research.run",
    runId: "research-run-1" as ResearchRunId,
    apiKey: "sk-secret-research-key",
    modelId: DEFAULT_DEEPSEEK_MODEL_ID,
    context: {
      currentDate: "2026-09-09",
      companyName: "Unitree Robotics",
      countryOrRegion: "China",
      industry: "Humanoid Robotics",
      researchScope: "Commercialization and core components",
      companyNote: "Candidate note for this industry only",
      timeScope: "Focus on the past year",
      customRequirements: "Assess overseas expansion",
    },
  };
}

describe("company research agent", () => {
  it("uses only the task snapshot, forces web search, and streams a completed report", async () => {
    const stream = [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Report part 1 "}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"source: https://example.com/report"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    ].join("");
    let requestUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = input;
      capturedInit = init;
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const events: CompanyResearchWorkerEvent[] = [];

    await createCompanyResearchAgent({ fetchFn }).run(
      request(),
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(String(requestUrl)).toBe("https://api.deepseek.com/responses");
    if (capturedInit === undefined) throw new Error("expected DeepSeek request options");
    const body = JSON.parse(String(capturedInit.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      stream: true,
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      max_output_tokens: 32768,
    });
    expect(body).not.toHaveProperty("messages");
    expect(body.instructions).toEqual(expect.stringContaining("company-research-v1"));
    expect(body.instructions).toEqual(expect.stringContaining("中文调研报告"));
    expect(body.instructions).toEqual(expect.stringContaining("每项重要结论只保留一个最合适的来源"));
    expect(body.instructions).toEqual(expect.stringContaining("完整的 http/https 网址"));
    expect(body.instructions).toEqual(expect.stringContaining("责任主体"));
    expect(body.instructions).toEqual(expect.stringContaining("尚未确认"));
    const input = body.input as Array<{ role: string; content: string }>;
    expect(input).toHaveLength(1);
    expect(input[0]?.role).toBe("user");
    for (const expected of [
      "2026-09-09",
      "Unitree Robotics",
      "China",
      "Humanoid Robotics",
      "Commercialization and core components",
      "Candidate note for this industry only",
      "Focus on the past year",
      "Assess overseas expansion",
    ]) {
      expect(input[0]?.content).toContain(expected);
    }
    expect(events).toEqual([
      { requestId: "research-request-1", runId: "research-run-1", type: "started" },
      {
        requestId: "research-request-1",
        runId: "research-run-1",
        type: "text_delta",
        delta: "Report part 1 ",
      },
      {
        requestId: "research-request-1",
        runId: "research-run-1",
        type: "text_delta",
        delta: "source: https://example.com/report",
      },
      {
        requestId: "research-request-1",
        runId: "research-run-1",
        type: "completed",
        text: "Report part 1 source: https://example.com/report",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("sk-secret-research-key");
  });

  it("maps response.incomplete to one fixed safe failure and never completes", async () => {
    const stream = [
      'data: {"type":"response.output_text.delta","delta":"partial report"}\n\n',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","error":"provider-secret-detail"}}\n\n',
    ].join("");
    const events: CompanyResearchWorkerEvent[] = [];
    const fetchFn = vi.fn(async () => new Response(stream, { status: 200 }));

    await createCompanyResearchAgent({ fetchFn }).run(
      request(),
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(events).toEqual([
      { requestId: "research-request-1", runId: "research-run-1", type: "started" },
      {
        requestId: "research-request-1",
        runId: "research-run-1",
        type: "text_delta",
        delta: "partial report",
      },
      {
        requestId: "research-request-1",
        runId: "research-run-1",
        type: "failed",
        code: "research_failed",
        message: "company research failed",
      },
    ]);
    expect(events.some((event) => event.type === "completed")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("provider-secret-detail");
  });
});
