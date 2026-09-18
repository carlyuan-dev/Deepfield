import { afterEach, expect, it, vi } from "vitest";
import { AppError, type CompanyResearchBatchState, type CompanyResearchWorkerRequest } from "@deepfield/contracts";
import { openTestDb, type TestDb } from "./application-test-helpers.js";
import { CompanyResearchService } from "./company-research-service.js";
import { CompanyResearchBatchService } from "./company-research-batch-service.js";
import { IndustryResearchService } from "./industry-research-service.js";
import { CompanyProfileEnrichmentService } from "./company-profile-enrichment-service.js";
import { profileResult } from "./company-profile-test-fixtures.js";
import type { CompanyResearchWorkerPort } from "./ports.js";
import { getCompanyResearchTemplate } from "@deepfield/contracts";
const dbs: TestDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.cleanup(); });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const input = { direction: "product_and_technology", asOfDate: "2026-09-01" } as const;
it("keeps cancellation retryable if terminal cleanup cannot commit", async () => {
  const f = setup();
  const first = f.batch.start(f.item.id, f.entries); await flush();
  const deletion = vi.spyOn(f.db.repos.companyResearchBatches, "deleteTerminal").mockImplementationOnce(() => { throw new Error("disk error"); });
  await expect(f.batch.cancel(first.batchId)).rejects.toMatchObject({ code: "STORAGE.FAILED" });
  expect(f.batch.isReserved()).toBe(true);
  expect(f.db.repos.companyResearchBatches.getById(first.batchId)?.status).toBe("cancelling");
  await f.batch.cancel(first.batchId);
  expect(f.batch.getState(f.item.id)).toBeNull();
  expect(f.db.repos.companyResearchBatches.getById(first.batchId)).toBeUndefined();
  deletion.mockRestore();
});
it("disposes terminal coordination snapshots before a listener admits the next batch", async () => {
  const f = setup();
  let nextId: string | undefined;
  const terminal: unknown[] = [];
  f.batch.subscribe(state => {
    if (state.status !== "completed") return;
    terminal.push(state);
    expect(f.db.repos.companyResearchBatches.getById(state.batchId)).toBeUndefined();
    expect(f.batch.getState(f.item.id)).toBeNull();
    nextId = f.batch.start(f.item.id, [f.entries[1]!]).batchId;
  });
  const first = f.batch.start(f.item.id, [f.entries[0]!]); await flush();
  f.releases.shift()!(); await flush();
  expect(terminal).toEqual([expect.objectContaining({ status: "completed", failed: 1 })]);
  expect(nextId).toBeDefined();
  expect(f.batch.getState(f.item.id)?.batchId).toBe(nextId);
  expect(f.db.repos.companyResearchBatches.getById(first.batchId)).toBeUndefined();
  expect(f.research.listRuns(f.item.id, f.companies[0]!.id)).toHaveLength(1);
  await f.batch.cancel(nextId!);
  expect(f.batch.getState(f.item.id)).toBeNull();
  expect(f.db.repos.companyResearchBatches.getById(nextId!)).toBeUndefined();
});
it.each(["waiting_profile", "running", "paused", "cancelling"] as const)("startup removes old terminal batches but recovers %s", status => {
  const f = setup(); f.batch.dispose();
  const base = { itemId: f.item.id, entries: [], processed: 0, total: 0, succeeded: 0, failed: 0 };
  f.db.repos.companyResearchBatches.save({ ...base, batchId: "old-complete", status: "completed" });
  f.db.repos.companyResearchBatches.save({ ...base, batchId: "old-cancel", status: "cancelled" });
  f.db.repos.companyResearchBatches.save({ ...base, batchId: "unfinished", status });
  const recovered = new CompanyResearchBatchService(f.db.repos, f.research);
  expect(f.db.repos.companyResearchBatches.getById("old-complete")).toBeUndefined();
  expect(f.db.repos.companyResearchBatches.getById("old-cancel")).toBeUndefined();
  expect(recovered.getState(f.item.id)).toMatchObject({ batchId: "unfinished", status: "paused" });
  recovered.dispose();
});
it.each(["waiting_profile", "running", "paused", "cancelling"] as const)("blocks batch-owned deletion in %s while allowing unrelated memberships", status => {
  const f = setup();
  const other = f.db.repos.capabilityItems.create({ industry: "其他" });
  f.db.repos.itemCompanies.add(other.id, f.companies[0]!.id);
  const extra = f.db.repos.companies.upsert({ name: "未选中" });
  f.db.repos.itemCompanies.add(f.item.id, extra.id);
  f.db.repos.companyResearchBatches.save({ batchId: "owned", itemId: f.item.id, status, entries: f.entries.map(entry => ({ ...entry, status: "pending" })), processed: 0, total: 2, succeeded: 0, failed: 0 });
  const industry = new IndustryResearchService(f.db.repos, { recognize: async () => [] });
  expect(() => industry.deleteItems([other.id, f.item.id])).toThrowError(expect.objectContaining({ code: "BUSINESS.CONFLICT" }));
  expect(industry.getItem(other.id)).toBeDefined();
  expect(() => industry.removeCompanies(f.item.id, [extra.id, f.companies[0]!.id])).toThrowError(expect.objectContaining({ code: "BUSINESS.CONFLICT" }));
  expect(industry.listCompanies(f.item.id)).toHaveLength(3);
  industry.removeCompany(other.id, f.companies[0]!.id);
  industry.removeCompany(f.item.id, extra.id);
  industry.deleteItem(other.id);
  expect(industry.listCompanies(f.item.id)).toHaveLength(2);
});
it.each(["resume", "cancel"] as const)("retains worker ownership after snapshot failure before %s", async action => {
  const f = setup(); const save = f.db.repos.companyResearchBatches.save;
  let failed = false;
  vi.spyOn(f.db.repos.companyResearchBatches, "save").mockImplementation(state => {
    if (!failed && f.requests.length === 1) { failed = true; throw new Error("one-shot disk error"); }
    save(state);
  });
  const state = f.batch.start(f.item.id, f.entries); await flush();
  expect(failed).toBe(true);
  expect(f.batch.getState(f.item.id)?.status).toBe("running");
  expect(() => f.batch.resume(state.batchId)).toThrowError(expect.objectContaining({ code: "BUSINESS.CONFLICT" }));
  expect(f.batch.isReserved()).toBe(true); expect(f.requests).toHaveLength(1);
  if (action === "cancel") {
    f.worker.cancelResearch = () => {};
    let acknowledged = false;
    const cancellation = f.batch.cancel(state.batchId).then(() => { acknowledged = true; });
    await flush(); expect(acknowledged).toBe(false); expect(f.batch.isReserved()).toBe(true);
    f.releases.shift()!(); await cancellation;
    expect(f.snapshots.at(-1)?.status).toBe("cancelled");
    expect(f.batch.getState(f.item.id)).toBeNull();
    expect(f.requests).toHaveLength(1);
    expect(f.research.listRuns(f.item.id, f.companies[0]!.id)).toEqual([]);
    return;
  }
  f.releases.shift()!(); await flush();
  expect(f.batch.getState(f.item.id)).toMatchObject({ status: "paused", processed: 1, failed: 1, issue: { code: "STORAGE.FAILED" } });
  f.batch.resume(state.batchId); await flush();
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]?.context.companyName).toBe("乙");
  await f.batch.cancel(state.batchId);
});
function setup() {
  const db = openTestDb(); dbs.push(db);
  const item = db.repos.capabilityItems.create({ industry: "测试" });
  const companies = ["甲", "乙"].map(name => { const c = db.repos.companies.upsert({ name }); db.repos.companies.setProfileStatus(c.id, "ready"); db.repos.itemCompanies.add(item.id, c.id); return c; });
  const requests: CompanyResearchWorkerRequest[] = []; const releases: (() => void)[] = [];
  const profiles = { resolveActiveLlm: async () => ({ id: "l", name: "l", provider: "custom", protocol: "openai_compatible", baseUrl: "https://a.test", modelId: "m", contextWindow: 32000, apiKey: "s" } as const), resolveActiveSearch: async () => ({ id: "s", name: "s", provider: "zhipu", baseUrl: "https://a.test", options: {}, apiKey: "s" } as const) };
  const worker: CompanyResearchWorkerPort = { sendResearch(request: CompanyResearchWorkerRequest) { requests.push(request); return (async function* () { await new Promise<void>(resolve => releases.push(resolve)); yield { type: "failed", requestId: request.requestId, runId: request.runId, stage: "raw", code: "model_failed", message: "company research failed" } as const; })(); }, cancelResearch() { releases.shift()?.(); } };
  const research = new CompanyResearchService(db.repos, profiles, worker, { requestIdFactory: () => crypto.randomUUID() });
  const batch = new CompanyResearchBatchService(db.repos, research);
  const snapshots: CompanyResearchBatchState[] = [];
  batch.subscribe(state => snapshots.push(state));
  return { db, item, companies, profiles, research, batch, worker, requests, releases, snapshots, entries: companies.map(c => ({ companyId: c.id, input })) };
}
it("reserves all queue gaps, creates only dispatched runs, and continues after individual failure", async () => {
  const f = setup(); const state = f.batch.start(f.item.id, f.entries); await flush();
  expect(f.requests).toHaveLength(1); expect(f.batch.getState(f.item.id)?.entries[1]?.runId).toBeUndefined();
  await expect(f.research.start(f.item.id, f.companies[1]!.id, input)).rejects.toMatchObject({ code: "BUSINESS.CONFLICT" });
  f.releases.shift()!(); await flush(); expect(f.requests).toHaveLength(2);
  f.releases.shift()!(); await flush(); expect(f.snapshots.at(-1)).toMatchObject({ batchId: state.batchId, status: "completed", processed: 2, failed: 2 });
  expect(f.batch.getState(f.item.id)).toBeNull();
});
const structured = JSON.stringify({ coreSummary: ["现有公开信息不足以形成可靠的核心判断。"], sections: ["products_and_positioning", "technology_and_metrics", "development_and_readiness", "competitive_position", "constraints_and_roadmap"].map(sectionId => ({ sectionId, status: "not_found", summary: null, facts: [] })) });
it("finishes raw and structure in order and preserves a terminal report racing cancellation", async () => {
  const f = setup(); let cancellation: Promise<void> | undefined;
  f.worker.sendResearch = request => (async function* () { f.requests.push(request); yield { type: "completed", requestId: request.requestId, runId: request.runId, stage: request.stage, text: request.stage === "raw" ? "原始报告" : structured } as const; })();
  f.research.subscribe(event => {
    if (event.type === "state_changed" && f.research.getRun(f.item.id, event.companyId, event.runId)?.status === "completed") cancellation = f.batch.cancel(f.batch.getState(f.item.id)!.batchId);
  });
  f.batch.start(f.item.id, f.entries); await flush(); await cancellation;
  expect(f.requests.map(r => r.stage)).toEqual(["raw", "structure"]);
  expect(f.snapshots.at(-1)).toMatchObject({ status: "cancelled", processed: 1, succeeded: 1 });
  expect(f.research.listRuns(f.item.id, f.companies[0]!.id)[0]?.status).toBe("completed");
});
it.each(["raw", "structure"] as const)("waits for cancellation acknowledgement during %s", async stage => {
  const f = setup(); let acknowledge!: () => void;
  f.worker.cancelResearch = () => {};
  f.worker.sendResearch = request => (async function* () {
    f.requests.push(request);
    if (stage === "structure" && request.stage === "raw") { yield { type: "completed", requestId: request.requestId, runId: request.runId, stage: "raw", text: "原始报告" } as const; return; }
    await new Promise<void>(resolve => { acknowledge = resolve; });
    yield { type: "cancelled", requestId: request.requestId, runId: request.runId, stage: request.stage } as const;
  })();
  const state = f.batch.start(f.item.id, f.entries); await flush(); let done = false;
  const cancelling = f.batch.cancel(state.batchId).then(() => { done = true; }); await flush();
  expect(done).toBe(false); expect(f.batch.isReserved()).toBe(true);
  acknowledge(); await cancelling;
  expect(f.research.listRuns(f.item.id, f.companies[0]!.id)).toEqual([]);
  expect(f.snapshots.at(-1)).toMatchObject({ status: "cancelled", processed: 0 });
});
it.each(["raw", "structure"] as const)("recovers %s as paused and resumes the appropriate existing stage", async stage => {
  const f = setup(); f.batch.dispose();
  const run = f.db.repos.companyResearchRuns.createResearching(f.item.id, f.companies[0]!.id, input, { ...input, currentDate: input.asOfDate, companyName: "甲", topicName: "测试" }, getCompanyResearchTemplate(input.direction));
  if (stage === "structure") { f.db.repos.companyResearchRuns.markSearchSucceeded(run.id); f.db.repos.companyResearchRuns.completeRaw(run.id, "原始报告"); }
  f.db.repos.companyResearchBatches.save({ batchId: "recover", itemId: f.item.id, status: "running", entries: [{ ...f.entries[0]!, runId: run.id, status: "running", stage }, f.entries[1]! && { ...f.entries[1]!, status: "pending" }], processed: 0, succeeded: 0, failed: 0, total: 2 });
  const recovered = new CompanyResearchBatchService(f.db.repos, f.research); await flush();
  expect(recovered.getState(f.item.id)?.status).toBe("paused"); expect(f.requests).toEqual([]);
  recovered.dispose();
  const again = new CompanyResearchBatchService(f.db.repos, f.research);
  expect(again.getState(f.item.id)?.entries[0]?.status).toBe("running");
  again.resume("recover"); await flush(); expect(f.requests[0]?.stage).toBe(stage); expect(f.requests[0]?.runId).toBe(run.id);
  await again.cancel("recover");
});
it("yields after active profile completion, starts no further profiles, then resumes enrichment", async () => {
  const f = setup(); f.batch.dispose(); let finish!: () => void;
  const extra = f.db.repos.companies.upsert({ name: "资料甲" }); const later = f.db.repos.companies.upsert({ name: "资料乙" });
  let batch: CompanyResearchBatchService | undefined;
  const enrichment = new CompanyProfileEnrichmentService(f.db.repos.companies, { prepare: async c => async () => { if (c.id === extra.id) await new Promise<void>(resolve => { finish = resolve; }); return profileResult(); } }, { isForegroundBusy: () => !!batch?.isReserved() });
  enrichment.start(); await flush(); batch = new CompanyResearchBatchService(f.db.repos, f.research, enrichment);
  const state = batch.start(f.item.id, f.entries); await flush(); expect(f.requests).toHaveLength(0);
  finish(); await flush(); expect(f.requests).toHaveLength(1); expect(f.db.repos.companies.getById(later.id)?.profileStatus).toBe("pending");
  await batch.cancel(state.batchId); await enrichment.whenIdle(); expect(f.db.repos.companies.getById(later.id)?.profileStatus).toBe("ready");
});
it("waits for terminal worker iterator release before starting the next company", async () => {
  const f = setup(); let release!: () => void;
  f.worker.sendResearch = request => (async function* () {
    f.requests.push(request);
    try { yield { type: "completed", requestId: request.requestId, runId: request.runId, stage: request.stage, text: request.stage === "raw" ? "原始报告" : structured } as const; }
    finally { if (request.stage === "structure" && request.context.companyName === "甲") await new Promise<void>(resolve => { release = resolve; }); }
  })();
  f.batch.start(f.item.id, f.entries); await flush();
  expect(f.research.listRuns(f.item.id, f.companies[0]!.id)[0]?.status).toBe("completed");
  expect(f.requests.map(r => r.stage)).toEqual(["raw", "structure"]);
  await expect(f.research.start(f.item.id, f.companies[1]!.id, input)).rejects.toMatchObject({ code: "BUSINESS.CONFLICT" });
  release(); await flush(); expect(f.requests.map(r => r.stage)).toEqual(["raw", "structure", "raw", "structure"]);
  expect(f.snapshots.at(-1)).toMatchObject({ status: "completed", succeeded: 2 });
});
it("persists owned run identity before first dispatch and cancels before dispatch without creating later reports", async () => {
  const f = setup(); let cancel: Promise<void> | undefined;
  f.research.subscribe(event => {
    if (event.type !== "state_changed" || !f.research.isRunning()) return;
    const stored = f.db.repos.companyResearchBatches.getActive()!;
    expect(stored.entries[0]?.runId).toBe(event.runId);
    cancel = f.batch.cancel(stored.batchId);
  });
  f.batch.start(f.item.id, f.entries); await flush(); await cancel;
  expect(f.requests).toHaveLength(0); expect(f.research.listRuns(f.item.id, f.companies[0]!.id)).toEqual([]);
});
it("cancels a profile-boundary wait without awaiting unrelated enrichment", async () => {
  const f = setup(); f.batch.dispose(); let finish!: () => void;
  const idle = new Promise<void>(resolve => { finish = resolve; });
  const batch = new CompanyResearchBatchService(f.db.repos, f.research, { whenIdle: () => idle, resume: () => {} });
  const state = batch.start(f.item.id, f.entries); await flush(); let done = false;
  const cancel = batch.cancel(state.batchId).then(() => { done = true; }); await flush();
  expect(done).toBe(true); expect(batch.isReserved()).toBe(false); expect(f.requests).toHaveLength(0);
  finish(); await cancel;
});
it("cancels recovered unfinished work while preserving an already terminal owned failure", async () => {
  const f = setup(); f.batch.dispose();
  const create = (index: number) => f.db.repos.companyResearchRuns.createResearching(f.item.id, f.companies[index]!.id, input, { ...input, currentDate: input.asOfDate, companyName: f.companies[index]!.name, topicName: "测试" }, getCompanyResearchTemplate(input.direction));
  const terminal = create(0); f.db.repos.companyResearchRuns.failResearching(terminal.id, "model_failed");
  const unfinished = create(1); f.db.repos.companyResearchRuns.completeRaw(unfinished.id, "待完成原文");
  f.db.repos.companyResearchBatches.save({ batchId: "recover-cancel", itemId: f.item.id, status: "running", entries: [{ ...f.entries[0]!, runId: terminal.id, status: "failed" }, { ...f.entries[1]!, runId: unfinished.id, status: "running", stage: "structure" }], processed: 1, failed: 1, succeeded: 0, total: 2 });
  const recovered = new CompanyResearchBatchService(f.db.repos, f.research);
  recovered.subscribe(state => f.snapshots.push(state));
  await Promise.all([recovered.cancel("recover-cancel"), recovered.cancel("recover-cancel")]);
  expect(f.research.getRun(f.item.id, f.companies[0]!.id, terminal.id)?.status).toBe("research_failed");
  expect(f.research.getRun(f.item.id, f.companies[1]!.id, unfinished.id)).toBeUndefined();
  expect(f.snapshots.at(-1)).toMatchObject({ status: "cancelled", processed: 1, failed: 1 });
  expect(recovered.getState(f.item.id)).toBeNull();
});
it("pauses configuration failure and restart without creating queued reports", async () => {
  const f = setup(); f.profiles.resolveActiveLlm = async () => { throw new AppError("CONFIG.CREDENTIAL_MISSING", { service: "llm" }); };
  f.batch.start(f.item.id, f.entries); await flush();
  expect(f.batch.getState(f.item.id)).toMatchObject({ status: "paused", processed: 0, issue: { category: "configuration" } });
  expect(f.requests).toHaveLength(0);
});
it("pauses explicit authentication failure without consuming remaining entries", async () => {
  const f = setup(); f.profiles.resolveActiveLlm = async () => { throw new AppError("EXTERNAL.AUTHENTICATION_FAILED", { service: "llm" }); };
  f.batch.start(f.item.id, f.entries); await flush();
  expect(f.batch.getState(f.item.id)).toMatchObject({ status: "paused", processed: 0, issue: { code: "EXTERNAL.AUTHENTICATION_FAILED" } });
});
it("cancels during asynchronous admission and never dispatches the next entry", async () => {
  const f = setup(); const original = f.profiles.resolveActiveLlm; let release!: () => void;
  f.profiles.resolveActiveLlm = async () => { await new Promise<void>(resolve => { release = resolve; }); return original(); };
  const state = f.batch.start(f.item.id, f.entries); await flush();
  const cancel = f.batch.cancel(state.batchId); expect(f.batch.getState(f.item.id)?.status).toBe("cancelling");
  release(); await cancel;
  expect(f.snapshots.at(-1)).toMatchObject({ status: "cancelled", processed: 0 });
  expect(f.research.listRuns(f.item.id, f.companies[0]!.id)).toEqual([]);
  expect(f.requests).toHaveLength(0);
});
