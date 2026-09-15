import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyResearchWorkerRequest, LlmRuntimeSnapshot, ResearchRunId, SearchRuntimeSnapshot } from "@deepfield/contracts";
import { CompanyResearchService, RAW_RESEARCH_POLICY, STRUCTURE_RESEARCH_POLICY } from "./company-research-service.js";
import type { CompanyResearchWorkerPort } from "./ports.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";

const dbs: TestDb[] = []; afterEach(() => { for (const db of dbs.splice(0)) db.cleanup(); });
const llm: LlmRuntimeSnapshot = { id: "l1", name: "LLM", provider: "custom", protocol: "openai_compatible", baseUrl: "https://llm.test/v1", modelId: "m", contextWindow: 32000, apiKey: "llm-secret" };
const search: SearchRuntimeSnapshot = { id: "s1", name: "Search", provider: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", options: {}, apiKey: "search-secret" };
const valid = { coreSummary: ["现有公开信息不足以形成可靠的核心判断。"], sections: ["products_and_positioning", "technology_and_metrics", "development_and_readiness", "competitive_position", "constraints_and_roadmap"].map((sectionId) => ({ sectionId, status: "not_found", summary: null, facts: [] })) };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(structureText = JSON.stringify(valid)) {
  const db = openTestDb(); dbs.push(db); const item = db.repos.capabilityItems.create({ industry: "智能眼镜" }); const company = db.repos.companies.upsert({ name: "小米" }); db.repos.itemCompanies.add(item.id, company.id);
  const requests: CompanyResearchWorkerRequest[] = []; const persistedBeforeStructure: boolean[] = [];
  const worker: CompanyResearchWorkerPort = { sendResearch(request: CompanyResearchWorkerRequest) { requests.push(structuredClone(request)); if (request.stage === "structure") { const persisted = db.repos.companyResearchRuns.getByIdForTarget(item.id, company.id, request.runId as ResearchRunId); persistedBeforeStructure.push(persisted?.schemaVersion === "company-research-report-v1" && persisted.rawReportText === "原始报告"); } return (async function* () { yield { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "completed", text: request.stage === "raw" ? "原始报告" : structureText } as const; })(); }, cancelResearch: vi.fn() };
  const profiles = { llmCalls: 0, searchCalls: 0, resolveActiveLlm: async () => { profiles.llmCalls++; return llm; }, resolveActiveSearch: async () => { profiles.searchCalls++; return search; } };
  let seq = 0; const service = new CompanyResearchService(db.repos, profiles, worker, { requestIdFactory: () => `r${++seq}`, now: () => new Date(2026, 8, 11) });
  return { db, item, company, requests, persistedBeforeStructure, profiles, service, worker };
}

describe("CompanyResearchService profile snapshots", () => {
  it("uses one LLM/Search snapshot across raw and structure after persisting raw Markdown", async () => {
    const f = setup(); const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    for (let i = 0; i < 10 && f.requests.length < 2; i++) await flush();
    expect(f.profiles).toMatchObject({ llmCalls: 1, searchCalls: 1 });
    expect(f.requests[0]).toMatchObject({ stage: "raw", llm, search, toolAccess: RAW_RESEARCH_POLICY });
    expect(f.requests[1]).toMatchObject({ stage: "structure", llm, toolAccess: STRUCTURE_RESEARCH_POLICY }); expect(f.requests[1]).not.toHaveProperty("search");
    expect(f.persistedBeforeStructure).toEqual([true]); expect(f.service.getRun(f.item.id, f.company.id, run.id)?.status).toBe("completed");
  });

  it("retryStructuring resolves only the current LLM", async () => {
    const f = setup("invalid"); const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    for (let i = 0; i < 10 && f.service.getRun(f.item.id, f.company.id, run.id)?.status !== "structure_failed"; i++) await flush();
    f.profiles.llmCalls = 0; f.profiles.searchCalls = 0;
    await f.service.retryStructuring(f.item.id, f.company.id, run.id); await flush();
    expect(f.profiles).toMatchObject({ llmCalls: 1, searchCalls: 0 });
    expect(f.requests.at(-1)).toMatchObject({ stage: "structure", toolAccess: STRUCTURE_RESEARCH_POLICY });
  });

  it("retains the latest safe tool activity in the in-memory state and emits it", async () => {
    const f = setup();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const activity = { requestId: "r1", runId: "run-ignored", stage: "raw", type: "tool_activity", callKey: "tool-1", name: "web_search", summary: "宇树科技", status: "running", budgetConsumed: true } as const;
    f.worker.sendResearch = (request: CompanyResearchWorkerRequest) => (async function* () {
      yield { ...activity, requestId: request.requestId, runId: request.runId };
      await paused;
      yield { requestId: request.requestId, runId: request.runId, stage: "raw", type: "failed", code: "tool_failed", message: "company research failed" } as const;
    })();
    const emitted: unknown[] = [];
    f.service.subscribe((event) => emitted.push(event));
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await flush();
    expect(f.service.getState(f.item.id, f.company.id).active?.latestActivity).toMatchObject({ callKey: "tool-1", name: "web_search", summary: "宇树科技", status: "running" });
    expect(emitted).toContainEqual(expect.objectContaining({ type: "tool_activity", runId: run.id, callKey: "tool-1" }));
    release();
    await flush();
    expect(emitted).toContainEqual(expect.objectContaining({ type: "state_changed", runId: run.id, outcome: "tool_failed" }));
  });

  it("classifies an invalid worker envelope as a safe protocol error", async () => {
    const f = setup();
    f.worker.sendResearch = (request) => (async function* () {
      yield { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "unknown" } as never;
    })();
    const emitted: unknown[] = [];
    f.service.subscribe((event) => emitted.push(event));
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await flush();
    expect(emitted).toContainEqual(expect.objectContaining({ type: "state_changed", runId: run.id, outcome: "protocol_error" }));
  });
});
