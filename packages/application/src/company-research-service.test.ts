import { afterEach, describe, expect, it, vi } from "vitest";
import { getCompanyResearchTemplate, type CompanyResearchEvent, type CompanyResearchWorkerEvent, type CompanyResearchWorkerRequest, type LlmRuntimeSnapshot, type ResearchRunId, type SearchRuntimeSnapshot, type StartCompanyResearchInput } from "@deepfield/contracts";
import { CompanyResearchService, RAW_RESEARCH_POLICY, STRUCTURE_RESEARCH_POLICY } from "./company-research-service.js";
import { AppError } from "@deepfield/contracts";
import type { CompanyResearchWorkerPort } from "./ports.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";

const dbs: TestDb[] = []; afterEach(() => { for (const db of dbs.splice(0)) db.cleanup(); });
const llm: LlmRuntimeSnapshot = { id: "l1", name: "LLM", provider: "custom", protocol: "openai_compatible", baseUrl: "https://llm.test/v1", modelId: "m", contextWindow: 32000, apiKey: "llm-secret" };
const search: SearchRuntimeSnapshot = { id: "s1", name: "Search", provider: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", options: {}, apiKey: "search-secret" };
const valid = { coreSummary: ["现有公开信息不足以形成可靠的核心判断。"], sections: ["products_and_positioning", "technology_and_metrics", "development_and_readiness", "competitive_position", "constraints_and_roadmap"].map((sectionId) => ({ sectionId, status: "not_found", summary: null, facts: [] })) };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !predicate(); i++) await flush();
  expect(predicate()).toBe(true);
}

function setup(structureText = JSON.stringify(valid)) {
  const db = openTestDb(); dbs.push(db); const item = db.repos.capabilityItems.create({ industry: "智能眼镜" }); const company = db.repos.companies.upsert({ name: "小米" }); db.repos.itemCompanies.add(item.id, company.id);
  const requests: CompanyResearchWorkerRequest[] = []; const persistedBeforeStructure: boolean[] = [];
  const worker: CompanyResearchWorkerPort = { sendResearch(request: CompanyResearchWorkerRequest) { requests.push(structuredClone(request)); if (request.stage === "structure") { const persisted = db.repos.companyResearchRuns.getByIdForTarget(item.id, company.id, request.runId as ResearchRunId); persistedBeforeStructure.push(persisted?.schemaVersion === "company-research-report-v1" && persisted.rawReportText === "原始报告"); } return (async function* () { yield { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "completed", text: request.stage === "raw" ? "原始报告" : structureText } as const; })(); }, cancelResearch: vi.fn() };
  const profiles = { llmCalls: 0, searchCalls: 0, resolveActiveLlm: async () => { profiles.llmCalls++; return llm; }, resolveActiveSearch: async () => { profiles.searchCalls++; return search; } };
  let seq = 0; const service = new CompanyResearchService(db.repos, profiles, worker, { requestIdFactory: () => `r${++seq}`, now: () => new Date(2026, 8, 11) });
  return { db, item, company, requests, persistedBeforeStructure, profiles, service, worker };
}

function seedFailed(f: ReturnType<typeof setup>, status: "research_failed" | "structure_failed", input: StartCompanyResearchInput = { direction: "product_and_technology", asOfDate: "2026-09-11" }) {
  const context = { ...input, currentDate: "2026-09-11", companyName: f.company.name, topicName: f.item.industry };
  const run = f.db.repos.companyResearchRuns.createResearching(
    f.item.id, f.company.id, input, context, getCompanyResearchTemplate(input.direction),
  );
  if (status === "research_failed") return f.db.repos.companyResearchRuns.failResearching(run.id, "tool_failed");
  f.db.repos.companyResearchRuns.completeRaw(run.id, "原始报告");
  return f.db.repos.companyResearchRuns.failStructuring(run.id);
}

function pauseWorker(f: ReturnType<typeof setup>) {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  f.worker.sendResearch = (request) => {
    f.requests.push(structuredClone(request));
    return (async function* () {
      await paused;
      yield { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "cancelled" } as const;
    })();
  };
  return release;
}

function recordDiagnostic(f: ReturnType<typeof setup>, runId: string, requestId: string, traceId: string) {
  f.db.repos.companyResearchDiagnostics.record({
    requestId, runId, traceId, stage: "raw", type: "model_diagnostic",
    phase: "synthesizing", agentTurns: 1, searchCalls: 1, fetchCalls: 0,
    maxModelInputCharsEstimate: 100, outputChars: 20, stopReason: "stop",
    startedAt: "2026-09-15T08:00:00.000Z", finishedAt: "2026-09-15T08:00:01.000Z", durationMs: 1000,
  });
}

function recordTool(f: ReturnType<typeof setup>, id: string, traceId: string) {
  f.db.repos.toolExecutions.start({
    id, traceId, actor: "main_agent", toolName: "web_search", toolVersion: 1,
    startedAt: "2026-09-15T08:00:00.000Z",
  });
}

describe("CompanyResearchService profile snapshots", () => {
  it.each(["llm", "search"] as const)("preserves authoritative missing %s credential detail", async (service) => {
    const f = setup();
    f.profiles[service === "llm" ? "resolveActiveLlm" : "resolveActiveSearch"] = async () => { throw new AppError("CONFIG.CREDENTIAL_MISSING", { service }); };
    await expect(f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" })).rejects.toMatchObject({ code: "CONFIG.CREDENTIAL_MISSING", context: { service } });
    expect(f.service.listRuns(f.item.id, f.company.id)).toEqual([]);
  });
  it("reserves legacy structure retry while resolving its LLM", async () => {
    const f = setup();
    const failed = seedFailed(f, "structure_failed");
    f.db.db.prepare("UPDATE company_research_runs SET search_status = 'unknown' WHERE id = ?").run(failed.id);
    let resolve!: (snapshot: LlmRuntimeSnapshot) => void;
    f.profiles.resolveActiveLlm = () => new Promise((done) => { resolve = done; });
    const pending = f.service.retryStructuring(f.item.id, f.company.id, failed.id);
    await expect(f.service.retryStructuring(f.item.id, f.company.id, failed.id)).rejects.toMatchObject({ code: "BUSINESS.CONFLICT" });
    resolve(llm);
    await pending;
    await waitUntil(() => !f.service.isRunning());
  });
  it.each([
    ["completed", undefined, "succeeded"],
    ["completed", "authentication_failed", "none"],
    ["failed", "authentication_failed", "none"],
    ["reused", undefined, "none"],
    ["skipped", undefined, "none"],
  ] as const)("records only real successful search activity: %s %s", async (status, errorCode, expected) => {
    const f = setup();
    f.worker.sendResearch = (request) => (async function* () {
      if (request.stage === "raw") yield {
        requestId: request.requestId, runId: request.runId, stage: "raw", type: "tool_activity",
        callKey: "search-1", name: "web_search", status, ...(errorCode ? { errorCode } : {}),
      } as const;
      yield { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "completed", text: request.stage === "raw" ? "原始报告" : JSON.stringify(valid) } as const;
    })();
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await waitUntil(() => !f.service.isRunning());
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({ status: "completed", searchStatus: expected });
  });

  it("persists success before raw completion and never downgrades it on later failure", async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.worker.sendResearch = (request) => (async function* () {
      const identity = { requestId: request.requestId, runId: request.runId, stage: "raw" } as const;
      yield { ...identity, type: "tool_activity", callKey: "s1", name: "web_search", status: "completed" } as const;
      await gate;
      yield { ...identity, type: "tool_activity", callKey: "s2", name: "web_search", status: "failed", errorCode: "authentication_failed" } as const;
      yield { ...identity, type: "failed", code: "model_failed", message: "company research failed" } as const;
    })();
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await flush();
    expect(f.db.repos.companyResearchRuns.getByIdForTarget(f.item.id, f.company.id, run.id)).toMatchObject({ status: "researching", searchStatus: "succeeded" });
    release();
    await waitUntil(() => !f.service.isRunning());
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({ status: "research_failed", searchStatus: "succeeded" });
  });

  it("ignores foreign success identities and non-search completions", async () => {
    const f = setup();
    f.worker.sendResearch = (request) => (async function* () {
      const activity = { requestId: request.requestId, runId: request.runId, stage: "raw", type: "tool_activity", callKey: "s1", name: "web_search", status: "completed" } as const;
      if (request.stage === "raw") {
        yield { ...activity, requestId: "late-request" };
        yield { ...activity, runId: "other-run" };
        yield { ...activity, stage: "structure" } as unknown as CompanyResearchWorkerEvent;
        yield { ...activity, name: "read_webpage" };
      }
      yield { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "completed", text: request.stage === "raw" ? "原始报告" : JSON.stringify(valid) } as const;
    })();
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await waitUntil(() => !f.service.isRunning());
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({ status: "completed", searchStatus: "none" });
  });

  it("retries an unsearched completed report in place using changed input", async () => {
    const f = setup();
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await waitUntil(() => !f.service.isRunning());
    f.requests.length = 0;
    const retried = await f.service.retryFailed(f.item.id, f.company.id, run.id, { direction: "market_and_commercialization", asOfDate: "2026-09-10", focusScope: "新范围" });
    expect(retried).toMatchObject({ id: run.id, status: "researching", searchStatus: "none", direction: "market_and_commercialization", focusScope: "新范围", asOfDate: "2026-09-10" });
    await waitUntil(() => !f.service.isRunning());
    expect(f.requests[0]).toMatchObject({ stage: "raw", context: { focusScope: "新范围" } });
  });

  it("reruns raw research for unchanged structure failure without search success", async () => {
    const f = setup();
    const failed = seedFailed(f, "structure_failed");
    await f.service.retryFailed(f.item.id, f.company.id, failed.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await waitUntil(() => !f.service.isRunning());
    expect(f.requests[0]).toMatchObject({ stage: "raw" });
    expect(f.profiles.searchCalls).toBe(1);
  });

  it("uses one LLM/Search snapshot across raw and structure after persisting raw Markdown", async () => {
    const f = setup(); const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    for (let i = 0; i < 10 && f.requests.length < 2; i++) await flush();
    expect(f.profiles).toMatchObject({ llmCalls: 1, searchCalls: 1 });
    expect(f.requests[0]).toMatchObject({ stage: "raw", llm, search, toolAccess: RAW_RESEARCH_POLICY });
    expect(f.requests[1]).toMatchObject({ stage: "structure", llm, toolAccess: STRUCTURE_RESEARCH_POLICY }); expect(f.requests[1]).not.toHaveProperty("search");
    expect(f.persistedBeforeStructure).toEqual([true]); expect(f.service.getRun(f.item.id, f.company.id, run.id)?.status).toBe("completed");
  });

  it("retryStructuring resolves only the current LLM for historical unknown search state", async () => {
    const f = setup("invalid"); const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    for (let i = 0; i < 10 && f.service.getRun(f.item.id, f.company.id, run.id)?.status !== "structure_failed"; i++) await flush();
    f.db.db.prepare("UPDATE company_research_runs SET search_status = 'unknown' WHERE id = ?").run(run.id);
    f.profiles.llmCalls = 0; f.profiles.searchCalls = 0;
    await f.service.retryStructuring(f.item.id, f.company.id, run.id); await flush();
    expect(f.profiles).toMatchObject({ llmCalls: 1, searchCalls: 0 });
    expect(f.requests.at(-1)).toMatchObject({ stage: "structure", toolAccess: STRUCTURE_RESEARCH_POLICY });
  });

  it("retryStructuring always reuses persisted raw even when search was never successful", async () => {
    const f = setup(); const failed = seedFailed(f, "structure_failed");
    const retried = await f.service.retryStructuring(f.item.id, f.company.id, failed.id);
    expect(retried).toMatchObject({ id: failed.id, status: "structuring", searchStatus: "none", rawReportText: "原始报告" });
    await waitUntil(() => !f.service.isRunning());
    expect(f.requests[0]).toMatchObject({ stage: "structure", rawReportText: "原始报告", toolAccess: STRUCTURE_RESEARCH_POLICY });
    expect(f.profiles.searchCalls).toBe(0);
  });

  it("allows repeated manual structure-only attempts without a retry cap", async () => {
    const f = setup("invalid"); const failed = seedFailed(f, "structure_failed");
    await f.service.retryStructuring(f.item.id, f.company.id, failed.id);
    await waitUntil(() => !f.service.isRunning());
    await f.service.retryStructuring(f.item.id, f.company.id, failed.id);
    await waitUntil(() => !f.service.isRunning());

    expect(f.requests.map((request) => request.stage)).toEqual(["structure", "structure"]);
    expect(f.service.getRun(f.item.id, f.company.id, failed.id)).toMatchObject({
      id: failed.id, status: "structure_failed", rawReportText: "原始报告", structuringAttempts: 3,
    });
    expect(f.profiles.searchCalls).toBe(0);
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

  it.each([
    ["tool_failed", "tool_failed"],
    ["model_failed", "model_failed"],
    ["empty_report", "empty_report"],
    ["protocol_leak", "protocol_leak"],
    ["language_validation_failed", "language_validation_failed"],
    ["incomplete_response", "incomplete_response"],
    ["web_search_failed", "tool_failed"],
    ["research_failed", "tool_failed"],
  ] as const)("persists raw worker failure %s as safe history code %s", async (workerCode, persistedCode) => {
    const f = setup();
    f.worker.sendResearch = (request) => (async function* () {
      yield {
        requestId: request.requestId, runId: request.runId, stage: "raw",
        type: "failed", code: workerCode,
        message: workerCode === "web_search_failed" ? "company research web search failed" : "company research failed",
      } as CompanyResearchWorkerEvent;
    })();
    const emitted: CompanyResearchEvent[] = [];
    f.service.subscribe((event) => emitted.push(event));
    const input = { direction: "product_and_technology" as const, focusScope: "  机器人  ", asOfDate: "2026-09-11" };
    const run = await f.service.start(f.item.id, f.company.id, input);
    await waitUntil(() => !f.service.isRunning());
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({
      id: run.id, status: "research_failed", direction: input.direction,
      focusScope: "机器人", asOfDate: input.asOfDate, lastFailureCode: persistedCode,
    });
    expect(f.service.listRuns(f.item.id, f.company.id)).toEqual([
      expect.objectContaining({ id: run.id, status: "research_failed", lastFailureCode: persistedCode }),
    ]);
    expect(emitted).toContainEqual(expect.objectContaining({
      type: "state_changed", runId: run.id, outcome: persistedCode,
    }));
  });

  it("classifies and persists an invalid worker envelope as a safe protocol error", async () => {
    const f = setup();
    f.worker.sendResearch = (request) => (async function* () {
      yield { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "unknown" } as never;
    })();
    const emitted: unknown[] = [];
    f.service.subscribe((event) => emitted.push(event));
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await waitUntil(() => !f.service.isRunning());
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({ status: "research_failed", lastFailureCode: "protocol_error" });
    expect(f.service.listRuns(f.item.id, f.company.id)).toHaveLength(1);
    expect(emitted).toContainEqual(expect.objectContaining({ type: "state_changed", runId: run.id, outcome: "protocol_error" }));
  });

  it("does not turn isolated diagnostic persistence failure into a product failure", async () => {
    const f = setup();
    f.db.repos.companyResearchDiagnostics.record = () => { throw new Error("sk-provider-secret"); };
    f.worker.sendResearch = (request) => (async function* () {
      yield {
        requestId: request.requestId, runId: request.runId, traceId: request.requestId,
        stage: request.stage, type: "model_diagnostic", phase: "synthesizing",
        agentTurns: 12, searchCalls: 8, fetchCalls: 7, maxModelInputCharsEstimate: 12000, outputChars: 0,
        stopReason: "error", errorCategory: "provider_failed",
        startedAt: "2026-09-15T08:00:00.000Z", finishedAt: "2026-09-15T08:00:10.000Z", durationMs: 10000,
      } as const;
      yield { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "completed", text: request.stage === "raw" ? "原始报告" : JSON.stringify(valid) } as const;
    })();
    const emitted: CompanyResearchEvent[] = [];
    f.service.subscribe((event) => emitted.push(event));
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await waitUntil(() => !f.service.isRunning());
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({ status: "completed" });
    expect(f.service.listRuns(f.item.id, f.company.id)).toHaveLength(1);
    expect(emitted).not.toContainEqual(expect.objectContaining({ type: "state_changed", runId: run.id, outcome: "storage_failed" }));
    expect(JSON.stringify(emitted)).not.toContain("sk-provider-secret");
  });

  it("persists safe application validation diagnostics when a worker bypasses structure validation", async () => {
    const f = setup("{broken");
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await waitUntil(() => !f.service.isRunning());

    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({ status: "structure_failed", rawReportText: "原始报告" });
    expect(f.db.repos.companyResearchDiagnostics.listByRunId(run.id)).toContainEqual(expect.objectContaining({
      stage: "structure", errorCategory: "json_parse", validationIssues: [{ path: "", expected: "json_object", actual: "string" }], failedCandidate: "{broken",
    }));
  });

  it("persists a safe storage_failed structure diagnostic when report persistence fails", async () => {
    const f = setup();
    f.db.repos.companyResearchRuns.completeStructured = () => { throw new Error("private database path"); };
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await waitUntil(() => !f.service.isRunning());

    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({ status: "structure_failed", rawReportText: "原始报告" });
    expect(f.db.repos.companyResearchDiagnostics.listByRunId(run.id)).toContainEqual(expect.objectContaining({
      stage: "structure", errorCategory: "storage_failed", stopReason: "unknown",
    }));
    expect(JSON.stringify(f.db.repos.companyResearchDiagnostics.listByRunId(run.id))).not.toContain("private database path");
  });

  it("emits only storage_failed and leaves the active row for recovery when failure persistence throws", async () => {
    const f = setup();
    f.worker.sendResearch = (request) => (async function* () {
      yield { requestId: request.requestId, runId: request.runId, stage: "raw", type: "failed", code: "tool_failed", message: "company research failed" } as const;
    })();
    f.db.repos.companyResearchRuns.failResearching = () => { throw new Error("sk-storage-secret"); };
    const emitted: CompanyResearchEvent[] = [];
    f.service.subscribe((event) => emitted.push(event));
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await flush();
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({ status: "researching" });
    expect(f.service.isRunning()).toBe(true);
    expect(emitted).toContainEqual(expect.objectContaining({ type: "state_changed", runId: run.id, outcome: "storage_failed" }));
    expect(JSON.stringify(emitted)).not.toContain("sk-storage-secret");
  });

  it("persists a model diagnostic alongside failed raw history", async () => {
    const f = setup();
    f.worker.sendResearch = (request) => (async function* () {
      yield {
        requestId: request.requestId, runId: request.runId, traceId: request.requestId,
        stage: request.stage, type: "model_diagnostic", phase: "synthesizing",
        agentTurns: 12, searchCalls: 8, fetchCalls: 7, maxModelInputCharsEstimate: 12000, outputChars: 0,
        stopReason: "error", errorCategory: "invalid_final_empty",
        startedAt: "2026-09-15T08:00:00.000Z", finishedAt: "2026-09-15T08:00:10.000Z", durationMs: 10000,
      } as const;
      yield { requestId: request.requestId, runId: request.runId, stage: "raw", type: "failed", code: "empty_report", message: "company research failed" } as const;
    })();
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await waitUntil(() => !f.service.isRunning());
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({ status: "research_failed", lastFailureCode: "empty_report" });
    expect(f.db.repos.companyResearchDiagnostics.getByRequestId("r1")).toMatchObject({ runId: run.id, traceId: "r1", errorCategory: "invalid_final_empty" });
  });

  it.each(["raw", "structure"] as const)("cancels %s work by deleting the active run", async (stage) => {
    const f = setup();
    let release!: () => void;
    let enteredStage!: () => void;
    const cancelled = new Promise<void>((resolve) => { release = resolve; });
    const stageEntered = new Promise<void>((resolve) => { enteredStage = resolve; });
    f.worker.sendResearch = (request) => (async function* () {
      if (request.stage === "raw" && stage === "structure") {
        yield { requestId: request.requestId, runId: request.runId, stage: "raw", type: "completed", text: "原始报告" } as const;
        return;
      }
      enteredStage();
      await cancelled;
      yield { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "cancelled" } as const;
    })();
    f.worker.cancelResearch = vi.fn(() => release());
    const emitted: CompanyResearchEvent[] = [];
    f.service.subscribe((event) => emitted.push(event));
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await stageEntered;
    await f.service.cancel(run.id);
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toBeUndefined();
    expect(f.service.listRuns(f.item.id, f.company.id)).toEqual([]);
    expect(emitted).toContainEqual(expect.objectContaining({ type: "state_changed", runId: run.id, outcome: "cancelled" }));
  });

  it("stores structure worker failure internally while emitting only a public failure outcome", async () => {
    const f = setup();
    f.worker.sendResearch = (request) => (async function* () {
      if (request.stage === "raw") {
        yield { requestId: request.requestId, runId: request.runId, stage: "raw", type: "completed", text: "原始报告" } as const;
      } else {
        yield { requestId: request.requestId, runId: request.runId, stage: "structure", type: "failed", code: "structuring_failed", message: "company research structuring failed" } as const;
      }
    })();
    const emitted: CompanyResearchEvent[] = [];
    f.service.subscribe((event) => emitted.push(event));
    const run = await f.service.start(f.item.id, f.company.id, { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await waitUntil(() => !f.service.isRunning());
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toMatchObject({ status: "structure_failed", lastFailureCode: "structuring_failed" });
    expect(emitted).toContainEqual(expect.objectContaining({ type: "state_changed", runId: run.id, outcome: "research_failed" }));
    expect(emitted).not.toContainEqual(expect.objectContaining({ type: "state_changed", outcome: "structuring_failed" }));
  });
});

describe("CompanyResearchService failed-run retry", () => {
  it("retries a research failure in place with normalized changed input and a full raw dispatch", async () => {
    const f = setup();
    const failed = seedFailed(f, "research_failed");
    const release = pauseWorker(f);
    f.profiles.llmCalls = 0; f.profiles.searchCalls = 0;
    const changedInput = { direction: "product_and_technology" as const, focusScope: "  核心零部件  ", asOfDate: "2026-09-10" };
    const retried = await f.service.retryFailed(f.item.id, f.company.id, failed.id, changedInput);
    expect(retried).toMatchObject({ id: failed.id, status: "researching", focusScope: "核心零部件", asOfDate: "2026-09-10" });
    expect(f.db.repos.companyResearchRuns.listRuns(f.item.id, f.company.id)).toHaveLength(0);
    await waitUntil(() => f.requests.length === 1);
    expect(f.profiles).toMatchObject({ llmCalls: 1, searchCalls: 1 });
    expect(f.requests[0]).toMatchObject({ runId: failed.id, stage: "raw", llm, search, toolAccess: RAW_RESEARCH_POLICY });
    release();
    await waitUntil(() => !f.service.isRunning());
  });

  it.each(["unknown", "succeeded"] as const)("retries unchanged %s structure failure in place using only LLM and structure dispatch", async (searchStatus) => {
    const f = setup();
    const input = { direction: "product_and_technology" as const, focusScope: "机器人", asOfDate: "2026-09-11" };
    const failed = seedFailed(f, "structure_failed", input);
    f.db.db.prepare("UPDATE company_research_runs SET search_status = ? WHERE id = ?").run(searchStatus, failed.id);
    const release = pauseWorker(f);
    f.profiles.llmCalls = 0; f.profiles.searchCalls = 0;
    const retried = await f.service.retryFailed(f.item.id, f.company.id, failed.id, { ...input, focusScope: "  机器人  " });
    expect(retried).toMatchObject({ id: failed.id, status: "structuring", rawReportText: "原始报告", structuringAttempts: 2, searchStatus });
    expect(f.db.repos.companyResearchRuns.listRuns(f.item.id, f.company.id)).toHaveLength(0);
    await waitUntil(() => f.requests.length === 1);
    expect(f.profiles).toMatchObject({ llmCalls: 1, searchCalls: 0 });
    expect(f.requests[0]).toMatchObject({ runId: failed.id, stage: "structure", llm, toolAccess: STRUCTURE_RESEARCH_POLICY, rawReportText: "原始报告" });
    expect(f.requests[0]).not.toHaveProperty("search");
    release();
    await waitUntil(() => !f.service.isRunning());
  });

  it("routes a changed structure failure through full raw research with rebuilt snapshots", async () => {
    const f = setup();
    const failed = seedFailed(f, "structure_failed", { direction: "product_and_technology", focusScope: "旧范围", asOfDate: "2026-09-11" });
    const release = pauseWorker(f);
    f.profiles.llmCalls = 0; f.profiles.searchCalls = 0;
    const retried = await f.service.retryFailed(f.item.id, f.company.id, failed.id, {
      direction: "value_chain_and_competition", focusScope: "新范围", asOfDate: "2026-09-10",
    });
    expect(retried).toMatchObject({ id: failed.id, status: "researching", direction: "value_chain_and_competition", focusScope: "新范围", asOfDate: "2026-09-10" });
    expect(retried).not.toHaveProperty("rawReportText");
    await waitUntil(() => f.requests.length === 1);
    expect(f.profiles).toMatchObject({ llmCalls: 1, searchCalls: 1 });
    expect(f.requests[0]).toMatchObject({ stage: "raw", context: { direction: "value_chain_and_competition", focusScope: "新范围", asOfDate: "2026-09-10" }, template: { templateId: "value_chain_and_competition" } });
    release();
    await waitUntil(() => !f.service.isRunning());
  });

  it("rejects invalid input before mutating the failed run or resolving profiles", async () => {
    const f = setup();
    const failed = seedFailed(f, "research_failed");
    f.profiles.llmCalls = 0; f.profiles.searchCalls = 0;
    await expect(f.service.retryFailed(f.item.id, f.company.id, failed.id, {
      direction: "product_and_technology", asOfDate: "2026-09-12",
    })).rejects.toThrow("invalid company research input");
    expect(f.service.getRun(f.item.id, f.company.id, failed.id)).toEqual(failed);
    expect(f.profiles).toMatchObject({ llmCalls: 0, searchCalls: 0 });
  });

  it("rejects wrong ownership before mutating the failed run or resolving profiles", async () => {
    const f = setup();
    const failed = seedFailed(f, "research_failed");
    const other = f.db.repos.capabilityItems.create({ industry: "其他" });
    f.db.repos.itemCompanies.add(other.id, f.company.id);
    f.profiles.llmCalls = 0; f.profiles.searchCalls = 0;
    await expect(f.service.retryFailed(other.id, f.company.id, failed.id, {
      direction: "product_and_technology", asOfDate: "2026-09-11",
    })).rejects.toThrow("cannot be retried");
    expect(f.service.getRun(f.item.id, f.company.id, failed.id)).toEqual(failed);
    expect(f.profiles).toMatchObject({ llmCalls: 0, searchCalls: 0 });
  });

  it("rejects global occupancy before mutating the failed run or resolving profiles", async () => {
    const f = setup();
    const failed = seedFailed(f, "research_failed");
    const otherItem = f.db.repos.capabilityItems.create({ industry: "其他" });
    const otherCompany = f.db.repos.companies.upsert({ name: "其他公司" });
    f.db.repos.itemCompanies.add(otherItem.id, otherCompany.id);
    f.db.repos.companyResearchRuns.createResearching(
      otherItem.id, otherCompany.id,
      { direction: "operations_and_performance", asOfDate: "2026-09-11" },
      { direction: "operations_and_performance", asOfDate: "2026-09-11", currentDate: "2026-09-11", companyName: otherCompany.name, topicName: otherItem.industry },
      getCompanyResearchTemplate("operations_and_performance"),
    );
    f.profiles.llmCalls = 0; f.profiles.searchCalls = 0;
    await expect(f.service.retryFailed(f.item.id, f.company.id, failed.id, {
      direction: "product_and_technology", asOfDate: "2026-09-11",
    })).rejects.toThrow("already running");
    expect(f.service.getRun(f.item.id, f.company.id, failed.id)).toEqual(failed);
    expect(f.profiles).toMatchObject({ llmCalls: 0, searchCalls: 0 });
  });

  it.each(["research_failed", "structure_failed"] as const)("sanitizes unknown profile failures before mutating %s history", async (status) => {
    const f = setup();
    const failed = seedFailed(f, status);
    f.profiles.resolveActiveLlm = async () => { f.profiles.llmCalls++; throw new Error("sk-provider-secret"); };
    f.profiles.llmCalls = 0; f.profiles.searchCalls = 0;
    await expect(f.service.retryFailed(f.item.id, f.company.id, failed.id, {
      direction: "product_and_technology", asOfDate: "2026-09-11",
    })).rejects.toMatchObject({ code: "INTERNAL.UNKNOWN" });
    expect(f.service.getRun(f.item.id, f.company.id, failed.id)).toEqual(failed);
    expect(f.profiles.llmCalls).toBe(1);
  });

  it("sanitizes an unknown Search failure before mutating raw-retry history", async () => {
    const f = setup();
    const failed = seedFailed(f, "research_failed");
    f.profiles.resolveActiveSearch = async () => { f.profiles.searchCalls++; throw new Error("sk-search-secret"); };
    f.profiles.llmCalls = 0; f.profiles.searchCalls = 0;
    await expect(f.service.retryFailed(f.item.id, f.company.id, failed.id, {
      direction: "product_and_technology", asOfDate: "2026-09-11",
    })).rejects.toMatchObject({ code: "INTERNAL.UNKNOWN" });
    expect(f.service.getRun(f.item.id, f.company.id, failed.id)).toEqual(failed);
    expect(f.profiles).toMatchObject({ llmCalls: 1, searchCalls: 1 });
  });

  it("keeps one same-ID history entry with the latest fields after a retried run fails again", async () => {
    const f = setup();
    const failed = seedFailed(f, "research_failed");
    f.worker.sendResearch = (request) => (async function* () {
      yield { requestId: request.requestId, runId: request.runId, stage: "raw", type: "failed", code: "model_failed", message: "company research failed" } as const;
    })();
    await f.service.retryFailed(f.item.id, f.company.id, failed.id, {
      direction: "market_and_commercialization", focusScope: "最新范围", asOfDate: "2026-09-10",
    });
    await waitUntil(() => !f.service.isRunning());
    expect(f.service.listRuns(f.item.id, f.company.id)).toEqual([
      expect.objectContaining({
        id: failed.id, status: "research_failed", direction: "market_and_commercialization",
        focusScope: "最新范围", asOfDate: "2026-09-10", lastFailureCode: "model_failed",
      }),
    ]);
  });
});

describe("CompanyResearchService run deletion", () => {
  it("deletes one terminal run with its diagnostics and trace-linked tools only", () => {
    const f = setup();
    const doomed = seedFailed(f, "research_failed");
    const kept = seedFailed(f, "research_failed", { direction: "market_and_commercialization", asOfDate: "2026-09-10" });
    recordDiagnostic(f, doomed.id, "request-doomed", "trace-doomed");
    recordDiagnostic(f, kept.id, "request-kept", "trace-kept");
    recordTool(f, "tool-doomed", "trace-doomed");
    recordTool(f, "tool-kept", "trace-kept");

    f.service.deleteRun(f.item.id, f.company.id, doomed.id);

    expect(f.service.getRun(f.item.id, f.company.id, doomed.id)).toBeUndefined();
    expect(f.service.getRun(f.item.id, f.company.id, kept.id)).toEqual(kept);
    expect(f.db.repos.companyResearchDiagnostics.listByRunId(doomed.id)).toEqual([]);
    expect(f.db.repos.companyResearchDiagnostics.listByRunId(kept.id)).toHaveLength(1);
    expect(f.db.repos.toolExecutions.getById("tool-doomed")).toBeUndefined();
    expect(f.db.repos.toolExecutions.getById("tool-kept")).toMatchObject({ traceId: "trace-kept" });
  });

  it("leaves every row unchanged when ownership is wrong", () => {
    const f = setup();
    const run = seedFailed(f, "research_failed");
    recordDiagnostic(f, run.id, "request-1", "trace-1");
    recordTool(f, "tool-1", "trace-1");
    const other = f.db.repos.capabilityItems.create({ industry: "其他" });
    f.db.repos.itemCompanies.add(other.id, f.company.id);
    expect(() => f.service.deleteRun(other.id, f.company.id, run.id)).toThrow("cannot be deleted");
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toEqual(run);
    expect(f.db.repos.companyResearchDiagnostics.listByRunId(run.id)).toHaveLength(1);
    expect(f.db.repos.toolExecutions.getById("tool-1")).toBeDefined();
  });

  it("leaves every row unchanged when the selected run is active", () => {
    const f = setup();
    const input = { direction: "product_and_technology" as const, asOfDate: "2026-09-11" };
    const context = { ...input, currentDate: "2026-09-11", companyName: f.company.name, topicName: f.item.industry };
    const run = f.db.repos.companyResearchRuns.createResearching(
      f.item.id, f.company.id, input, context, getCompanyResearchTemplate(context.direction),
    );
    recordDiagnostic(f, run.id, "request-1", "trace-1");
    recordTool(f, "tool-1", "trace-1");
    expect(() => f.service.deleteRun(f.item.id, f.company.id, run.id)).toThrow("cannot be deleted");
    expect(f.service.getRun(f.item.id, f.company.id, run.id)).toEqual(run);
    expect(f.db.repos.companyResearchDiagnostics.listByRunId(run.id)).toHaveLength(1);
    expect(f.db.repos.toolExecutions.getById("tool-1")).toBeDefined();
  });

  it("leaves terminal data unchanged while any other run occupies the global active slot", () => {
    const f = setup();
    const terminal = seedFailed(f, "research_failed");
    recordDiagnostic(f, terminal.id, "request-1", "trace-1");
    recordTool(f, "tool-1", "trace-1");
    const otherItem = f.db.repos.capabilityItems.create({ industry: "其他" });
    const otherCompany = f.db.repos.companies.upsert({ name: "其他公司" });
    f.db.repos.itemCompanies.add(otherItem.id, otherCompany.id);
    f.db.repos.companyResearchRuns.createResearching(
      otherItem.id, otherCompany.id,
      { direction: "operations_and_performance", asOfDate: "2026-09-11" },
      { direction: "operations_and_performance", asOfDate: "2026-09-11", currentDate: "2026-09-11", companyName: otherCompany.name, topicName: otherItem.industry },
      getCompanyResearchTemplate("operations_and_performance"),
    );
    expect(() => f.service.deleteRun(f.item.id, f.company.id, terminal.id)).toThrow("already running");
    expect(f.service.getRun(f.item.id, f.company.id, terminal.id)).toEqual(terminal);
    expect(f.db.repos.companyResearchDiagnostics.listByRunId(terminal.id)).toHaveLength(1);
    expect(f.db.repos.toolExecutions.getById("tool-1")).toBeDefined();
  });

  it("rolls back diagnostics and tool cleanup when terminal deletion fails", () => {
    const f = setup();
    const terminal = seedFailed(f, "research_failed");
    recordDiagnostic(f, terminal.id, "request-1", "trace-1");
    recordTool(f, "tool-1", "trace-1");
    f.db.repos.companyResearchRuns.deleteTerminal = () => { throw new Error("sqlite secret"); };
    expect(() => f.service.deleteRun(f.item.id, f.company.id, terminal.id)).toThrow("could not be deleted");
    expect(f.service.getRun(f.item.id, f.company.id, terminal.id)).toEqual(terminal);
    expect(f.db.repos.companyResearchDiagnostics.listByRunId(terminal.id)).toHaveLength(1);
    expect(f.db.repos.toolExecutions.getById("tool-1")).toBeDefined();
  });
});
