import { describe, expect, it, vi } from "vitest";
import { FakeAuditSink } from "@deepfield/tool-platform";
import type { CompanyProfileWorkerEvent, CompanyProfileWorkerRequest } from "../contracts/index.js";
import { createCompanyProfileAgent } from "./company-profile-agent.js";
import { createToolRuntime } from "../../../apps/desktop/src/worker/tools/tool-runtime.js";
import { assistant, makeRecordingInstalledPiRuntime, stubModel } from "../../../apps/desktop/src/worker/agent/pi-chat-agent-test-helpers.js";
import { rawResearchRequest } from "./company-research-test-helpers.js";
import { SearchProviderError } from "@deepfield/retrieval";
import { profileResult } from "../../../packages/application/src/testing/company-profile-test-fixtures.js";
import type { ModelGateway } from "../../../apps/desktop/src/shared/model-gateway.js";

function gatewayWithCompleteText(completeText: ModelGateway["completeText"]): ModelGateway {
  return {
    createModel: () => stubModel,
    getApiKey: async (snapshot) => snapshot.apiKey,
    completeText,
  };
}

describe("profile capability generic Agent run", () => {
  it.each([
    ["json_parse", "这是中文资料说明，但不是JSON。公司资料已经核实。sk-secret"],
    ["agent_failed", "English only sk-secret"],
    ["schema_invalid", JSON.stringify({ identity: { disposition: "matched", matchedName: "公司", reason: "证据", sources: [{ url: "https://example.com", kind: "search_snippet" }] }, fields: { legalName: "公司" }, fieldEvidence: { legalName: ["sk-secret"] } })],
  ])("reports safe %s after successful retrieval", async (code, output) => {
    const raw = rawResearchRequest(); const tools = createToolRuntime({ audit: new FakeAuditSink() });
    const completeText = vi.fn(async () => output);
    const recording = makeRecordingInstalledPiRuntime([
      assistant("", { stopReason: "toolUse", content: [{ type: "toolCall", id: "search", name: "web_search", arguments: { query: "公司" } }] }),
      assistant(output), assistant(output),
    ]);
    const events: CompanyProfileWorkerEvent[] = [];
    await createCompanyProfileAgent({ piRuntime: recording.runtime, gateway: gatewayWithCompleteText(completeText), toolSessions: { ...tools,
      bindSearchProvider: (trace, _provider, limits) => tools.bindSearchProvider(trace, { id: "fixture", capabilities: { timeRange: false }, search: async () => ({ provider: "fixture", results: [{ title: "公司", url: "https://example.com", snippet: "公司资料", rank: 1, provider: "fixture" }] }) }, limits),
    } }).run({ kind: "company-profile.enrich", requestId: "trace", companyId: "c1", name: "公司", researchTopics: [], existingFields: {}, llm: raw.llm, search: raw.search }, (event) => events.push(event), new AbortController().signal);
    expect(events[0]).toMatchObject({ type: "diagnostic", code, searchSourceCount: 1, searchToolCalls: 1, model: { stopReason: "stop" } });
    expect(events[1]).toMatchObject({ type: "failed", code: code === "agent_failed" ? "agent_failed" : "invalid_evidence" });
    expect(JSON.stringify(events)).not.toContain("sk-secret");
    if (code === "schema_invalid") expect(events[0]).toMatchObject({ schemaIssues: [{ path: "/fieldEvidence/legalName/0", expected: "object", actual: "string" }] });
    if (code === "agent_failed") expect(events[0]).toMatchObject({ piError: "invalid_final_language", model: { errorCategory: "invalid_final_language" } });
    expect(completeText).toHaveBeenCalledTimes(code === "agent_failed" ? 0 : 1);
  });
  it.each(["no_search", "empty_search", "failed_search"])("cannot complete from model memory when %s", async (mode) => {
    const raw = rawResearchRequest();
    const search = vi.fn(async () => { if (mode === "failed_search") throw new SearchProviderError("unauthorized"); return { provider: "fixture", results: [] }; });
    const tools = createToolRuntime({ audit: new FakeAuditSink() });
    const { sources: _sources, ...candidate } = profileResult();
    const recording = makeRecordingInstalledPiRuntime([
      ...(mode === "no_search" ? [] : [assistant("", { stopReason: "toolUse", content: [{ type: "toolCall", id: "search", name: "web_search", arguments: { query: "测试公司" } }] })]),
      assistant(JSON.stringify(candidate)), assistant(JSON.stringify(candidate)),
    ]);
    const events: CompanyProfileWorkerEvent[] = [];
    await createCompanyProfileAgent({ piRuntime: recording.runtime, toolSessions: { ...tools,
      bindSearchProvider: (trace, _provider, limits) => tools.bindSearchProvider(trace, { id: "fixture", capabilities: { timeRange: false }, search }, limits),
    } }).run({ kind: "company-profile.enrich", requestId: `profile-${mode}`, companyId: "c1", name: "测试公司", researchTopics: [], existingFields: {}, llm: raw.llm, search: raw.search }, (event) => events.push(event), new AbortController().signal);
    expect(events).toEqual([expect.objectContaining({ type: "diagnostic", code: "search_unavailable", phase: "evidence" }), expect.objectContaining({ type: "failed", code: "search_unavailable" })]);
    expect(search).toHaveBeenCalledTimes(mode === "no_search" ? 0 : 1);
  });
  it("enforces 3 search + 2 reads and closes in the same run with tools disabled and evidence retained", async () => {
    const raw = rawResearchRequest();
    const request: CompanyProfileWorkerRequest = { kind: "company-profile.enrich", requestId: "profile-1", companyId: "company-1", name: "示例公司", researchTopics: ["机器人"], existingFields: { headquarters: "已有地点" }, llm: raw.llm, search: raw.search };
    const search = vi.fn(async () => ({ provider: "fixture", results: [1, 2, 3].map((i) => ({ title: "示例公司", url: `https://example.com/${i}`, snippet: "示例公司是注册全称", rank: i, provider: "fixture" })) }));
    const fetch = vi.fn(async (url: string) => {
      const body = Buffer.from("<html><title>示例公司</title><body><main><p>示例公司的注册全称是示例公司。</p></main></body></html>");
      return { statusCode: 200, finalUrl: url, contentType: "text/html", body, decompressedBytes: body.length, sha256: "fixture" };
    });
    const tools = createToolRuntime({ audit: new FakeAuditSink(), retrieval: { transport: { fetch } } });
    const bind = vi.fn((trace: string, _provider: unknown, limits: Parameters<typeof tools.bindSearchProvider>[2]) => tools.bindSearchProvider(trace, { id: "fixture", capabilities: { timeRange: false }, search }, limits));
    const reference = { url: "https://example.com/1", kind: "opened_page" };
    const result = { identity: { disposition: "matched", matchedName: "示例公司", reason: "网页确认了主体", sources: [reference] }, fields: { legalName: "示例公司" }, fieldEvidence: { legalName: [reference] } };
    const recording = makeRecordingInstalledPiRuntime([
      assistant("", { stopReason: "toolUse", content: [1, 2, 3, 4].map((i) => ({ type: "toolCall", id: `search-${i}`, name: "web_search", arguments: { query: `示例公司 ${i}` } })) }),
      assistant("", { stopReason: "toolUse", content: [1, 2, 3].map((i) => ({ type: "toolCall", id: `read-${i}`, name: "read_webpage", arguments: { url: `https://example.com/${i}` } })) }),
      assistant("证据足够，准备输出最终结构。"),
      assistant(JSON.stringify(result)),
    ]);
    const createAgent = vi.spyOn(recording.runtime, "createAgent");
    const events: CompanyProfileWorkerEvent[] = [];
    await createCompanyProfileAgent({ piRuntime: recording.runtime, toolSessions: { ...tools, bindSearchProvider: bind } }).run(request, (event) => events.push(event), new AbortController().signal);
    expect(search).toHaveBeenCalledTimes(3); expect(fetch).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledWith("profile-1", expect.objectContaining({ id: request.search.provider }), { maxCalls: 13, categoryCalls: { search: 3, fetch: 2 } });
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(recording.requests.at(-1)?.tools).toEqual([]);
    expect(recording.requests.at(-1)?.systemPrompt).not.toContain("必须先搜索");
    expect(JSON.stringify(recording.requests.at(-1)?.messages)).toContain("注册全称");
    expect(events).toEqual([expect.objectContaining({ type: "diagnostic", code: "ok", phase: "complete", searchToolCalls: 3, readToolCalls: 2, searchSourceCount: 3, openedSourceCount: 2 }), expect.objectContaining({ kind: "company-profile.event", type: "completed", result: expect.objectContaining({ fields: { legalName: "示例公司" }, sources: [expect.objectContaining(reference)] }) })]);
    expect(tools.traceLedgerCount()).toBe(0);
  });

  it.each([
    ["malformed JSON", "这不是JSON"],
    ["schema-invalid JSON", JSON.stringify({
      identity: { disposition: "matched", matchedName: "示例公司", reason: "网页确认了主体", sources: [{ url: "https://example.com", kind: "search_snippet" }] },
      fields: { legalName: "示例公司" },
      fieldEvidence: { legalName: ["https://example.com"] },
    })],
  ])("repairs %s once without another agent or search", async (_case, firstOutput) => {
    const raw = rawResearchRequest();
    const tools = createToolRuntime({ audit: new FakeAuditSink() });
    const search = vi.fn(async () => ({ provider: "fixture", results: [{ title: "示例公司", url: "https://example.com", snippet: "示例公司经营机器人业务", rank: 1, provider: "fixture" }] }));
    const ref = { url: "https://example.com", kind: "search_snippet" as const };
    const corrected = { identity: { disposition: "matched", matchedName: "示例公司", reason: "网页确认了主体", sources: [ref] }, fields: { legalName: "示例公司" }, fieldEvidence: { legalName: [ref] } };
    const completeText = vi.fn(async (_snapshot: unknown, _system: string, _prompt: string, _signal?: AbortSignal) => JSON.stringify(corrected));
    const recording = makeRecordingInstalledPiRuntime([
      assistant("", { stopReason: "toolUse", content: [{ type: "toolCall", id: "search", name: "web_search", arguments: { query: "示例公司 机器人" } }] }),
      assistant(firstOutput), assistant(firstOutput),
    ]);
    const createAgent = vi.spyOn(recording.runtime, "createAgent");
    const events: CompanyProfileWorkerEvent[] = [];
    const request: CompanyProfileWorkerRequest = { kind: "company-profile.enrich", requestId: "repair-once", companyId: "c1", name: "示例公司", researchTopics: ["机器人"], existingFields: {}, llm: raw.llm, search: raw.search };

    await createCompanyProfileAgent({
      piRuntime: recording.runtime,
      gateway: gatewayWithCompleteText(completeText),
      toolSessions: { ...tools, bindSearchProvider: (trace, _provider, limits) => tools.bindSearchProvider(trace, { id: "fixture", capabilities: { timeRange: false }, search }, limits) },
    }).run(request, (event) => events.push(event), new AbortController().signal);

    expect(createAgent).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledOnce();
    expect(completeText).toHaveBeenCalledOnce();
    expect(completeText).toHaveBeenCalledWith(
      request.llm,
      expect.stringContaining("不能调用工具"),
      expect.stringContaining("示例公司经营机器人业务"),
      expect.any(AbortSignal),
    );
    expect(JSON.parse(completeText.mock.calls[0]?.[2] ?? "{}")).toMatchObject({ previousCandidate: firstOutput });
    expect(events).toEqual([
      expect.objectContaining({ type: "diagnostic", code: "ok", formatRepair: { attempted: true, outcome: "succeeded", durationMs: expect.any(Number) } }),
      expect.objectContaining({ type: "completed", result: expect.objectContaining({ fields: { legalName: "示例公司" } }) }),
    ]);
  });

  it.each([
    ["a second malformed candidate", "still-not-json", "json_parse"],
    ["fabricated corrected evidence", JSON.stringify({
      identity: { disposition: "matched", matchedName: "示例公司", reason: "网页确认了主体", sources: [{ url: "https://invented.test", kind: "search_snippet" }] },
      fields: { legalName: "示例公司" },
      fieldEvidence: { legalName: [{ url: "https://invented.test", kind: "search_snippet" }] },
    }), "source_missing"],
  ])("rejects %s after exactly one repair call", async (_case, repairedOutput, code) => {
    const raw = rawResearchRequest();
    const tools = createToolRuntime({ audit: new FakeAuditSink() });
    const completeText = vi.fn(async () => repairedOutput);
    const recording = makeRecordingInstalledPiRuntime([
      assistant("", { stopReason: "toolUse", content: [{ type: "toolCall", id: "search", name: "web_search", arguments: { query: "示例公司" } }] }),
      assistant("这不是JSON"), assistant("这不是JSON"),
    ]);
    const events: CompanyProfileWorkerEvent[] = [];
    await createCompanyProfileAgent({
      piRuntime: recording.runtime,
      gateway: gatewayWithCompleteText(completeText),
      toolSessions: { ...tools, bindSearchProvider: (trace, _provider, limits) => tools.bindSearchProvider(trace, { id: "fixture", capabilities: { timeRange: false }, search: async () => ({ provider: "fixture", results: [{ title: "示例公司", url: "https://example.com", snippet: "示例公司资料", rank: 1, provider: "fixture" }] }) }, limits) },
    }).run({ kind: "company-profile.enrich", requestId: "repair-invalid", companyId: "c1", name: "示例公司", researchTopics: [], existingFields: {}, llm: raw.llm, search: raw.search }, (event) => events.push(event), new AbortController().signal);

    expect(completeText).toHaveBeenCalledOnce();
    expect(events[0]).toMatchObject({ type: "diagnostic", code, formatRepair: { attempted: true, outcome: "invalid", durationMs: expect.any(Number) } });
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "invalid_evidence" });
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("does not repair a genuine schema-valid ambiguous result", async () => {
    const raw = rawResearchRequest();
    const tools = createToolRuntime({ audit: new FakeAuditSink() });
    const completeText = vi.fn();
    const ref = { url: "https://example.com", kind: "search_snippet" as const };
    const ambiguous = JSON.stringify({ identity: { disposition: "ambiguous", reason: "证据仍无法区分两个手机业务主体", sources: [ref] }, fields: {}, fieldEvidence: {} });
    const recording = makeRecordingInstalledPiRuntime([
      assistant("", { stopReason: "toolUse", content: [{ type: "toolCall", id: "search", name: "web_search", arguments: { query: "公司 手机" } }] }),
      assistant(ambiguous), assistant(ambiguous),
    ]);
    const events: CompanyProfileWorkerEvent[] = [];
    await createCompanyProfileAgent({
      piRuntime: recording.runtime,
      gateway: gatewayWithCompleteText(completeText),
      toolSessions: { ...tools, bindSearchProvider: (trace, _provider, limits) => tools.bindSearchProvider(trace, { id: "fixture", capabilities: { timeRange: false }, search: async () => ({ provider: "fixture", results: [{ title: "公司手机业务", url: ref.url, snippet: "存在两个无法区分的主体", rank: 1, provider: "fixture" }] }) }, limits) },
    }).run({ kind: "company-profile.enrich", requestId: "ambiguous", companyId: "c1", name: "公司", researchTopics: ["手机"], existingFields: {}, llm: raw.llm, search: raw.search }, (event) => events.push(event), new AbortController().signal);

    expect(completeText).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "completed", result: { identity: { disposition: "ambiguous" } } });
  });

  it("cannot emit success when cancelled during format repair", async () => {
    const raw = rawResearchRequest();
    const tools = createToolRuntime({ audit: new FakeAuditSink() });
    let rejectRepair!: (error: Error) => void;
    const completeText = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectRepair = reject; }));
    const recording = makeRecordingInstalledPiRuntime([
      assistant("", { stopReason: "toolUse", content: [{ type: "toolCall", id: "search", name: "web_search", arguments: { query: "示例公司" } }] }),
      assistant("这不是JSON"), assistant("这不是JSON"),
    ]);
    const controller = new AbortController();
    const events: CompanyProfileWorkerEvent[] = [];
    const run = createCompanyProfileAgent({
      piRuntime: recording.runtime,
      gateway: gatewayWithCompleteText(completeText),
      toolSessions: { ...tools, bindSearchProvider: (trace, _provider, limits) => tools.bindSearchProvider(trace, { id: "fixture", capabilities: { timeRange: false }, search: async () => ({ provider: "fixture", results: [{ title: "示例公司", url: "https://example.com", snippet: "示例公司资料", rank: 1, provider: "fixture" }] }) }, limits) },
    }).run({ kind: "company-profile.enrich", requestId: "repair-cancel", companyId: "c1", name: "示例公司", researchTopics: [], existingFields: {}, llm: raw.llm, search: raw.search }, (event) => events.push(event), controller.signal);
    await vi.waitFor(() => expect(completeText).toHaveBeenCalledOnce());
    controller.abort();
    rejectRepair(new Error("private provider body"));
    await run;

    expect(events[0]).toMatchObject({ type: "diagnostic", formatRepair: { attempted: true, outcome: "cancelled", durationMs: expect.any(Number) } });
    expect(events.some((event) => event.type === "completed")).toBe(false);
  });

  it("does not spend a repair call when malformed output has no search evidence", async () => {
    const raw = rawResearchRequest();
    const tools = createToolRuntime({ audit: new FakeAuditSink() });
    const completeText = vi.fn(async () => "不应调用");
    const recording = makeRecordingInstalledPiRuntime([assistant("这不是JSON"), assistant("这不是JSON")]);
    const events: CompanyProfileWorkerEvent[] = [];
    await createCompanyProfileAgent({ piRuntime: recording.runtime, gateway: gatewayWithCompleteText(completeText), toolSessions: tools })
      .run({ kind: "company-profile.enrich", requestId: "no-evidence-repair", companyId: "c1", name: "示例公司", researchTopics: [], existingFields: {}, llm: raw.llm, search: raw.search }, (event) => events.push(event), new AbortController().signal);

    expect(completeText).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({ type: "diagnostic", code: "search_unavailable" }),
      expect.objectContaining({ type: "failed", code: "search_unavailable" }),
    ]);
  });
});
