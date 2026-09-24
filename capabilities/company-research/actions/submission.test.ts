import { afterEach, expect, it, vi } from "vitest";
import { openTestDb, type TestDb } from "../../../packages/application/src/testing/application-test-helpers.js";
import { CompanyResearchService } from "../application/company-research-service.js";
import { CompanyResearchBatchService } from "../application/company-research-batch-service.js";
import { ResearchDrafts } from "./drafts.js";
import { ResearchSubmission } from "./handlers.js";
import type { CompanyResearchWorkerPort } from "../host-ports.js";
import { artifactRef } from "./task-artifact-adapter.js";
const dbs: TestDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.cleanup(); });
const input = { direction: "product_and_technology", asOfDate: "2026-09-01" } as const;
function setup(blocked = true, names: (itemId: string, companyId: string) => { topicName: string; companyName: string } = () => ({ topicName: "半导体", companyName: "甲" })) {
  const db = openTestDb(); dbs.push(db);
  const item = db.repos.capabilityItems.create({ industry: "半导体" });
  const company = db.repos.companies.upsert({ name: "甲" });
  db.repos.companies.setProfileStatus(company.id, "ready");
  db.repos.itemCompanies.add(item.id, company.id);
  const profiles = { resolveActiveLlm: async () => ({ id: "l", name: "l", provider: "custom", protocol: "openai_compatible", baseUrl: "https://offline.test", modelId: "m", contextWindow: 32000, apiKey: "offline" } as const), resolveActiveSearch: async () => ({ id: "s", name: "s", provider: "zhipu", baseUrl: "https://offline.test", options: {}, apiKey: "offline" } as const) };
  const releases = new Map<string, () => void>();
  const cancelled = new Set<string>();
  const worker: CompanyResearchWorkerPort = {
    sendResearch: request => blocked ? (async function* () {
      if (cancelled.has(request.requestId)) return;
      await new Promise<void>(resolve => { releases.set(request.requestId, resolve); });
    })() : (async function* () {})(),
    cancelResearch(requestId) { cancelled.add(requestId); releases.get(requestId)?.(); releases.delete(requestId); },
  };
  const research = new CompanyResearchService(db.repos, profiles, worker, { requestIdFactory: () => crypto.randomUUID() });
  const batch = new CompanyResearchBatchService(db.repos, research, { resume() {} });
  const drafts = new ResearchDrafts(db.repos.companyResearchProtocol, research);
  const submission = new ResearchSubmission(drafts, batch, profiles, research, names);
  return { db, item, company, worker, profiles, research, batch, drafts, submission, params: { itemId: item.id, companyId: company.id, ...input } };
}
it("keeps single, batch, and UI admissions working when display-name lookup fails", async () => {
  const f = setup(true, () => { throw new Error("display lookup unavailable"); });
  const single = await f.submission.submit(f.drafts.prepare(f.params), "name-single");
  expect(single.status).toBe("queued");
  expect(single.presentation?.text).toContain("当前公司");
  await f.batch.cancel(f.batch.getState(f.item.id)!.batchId);
  const group = await f.submission.submitBatch(f.item.id, [{ companyId: f.company.id, input }], "name-batch");
  expect(group.status).toBe("queued");
  expect(group.presentation?.text).toContain("当前主题");
  await f.batch.cancel(f.batch.getState(f.item.id)!.batchId);
  const ui = await f.submission.submitUi(f.item.id, [{ companyId: f.company.id, input }]);
  expect(ui.entries).toHaveLength(1);
  f.batch.dispose();
});
it.each(["pending", "failed"] as const)("admits %s profile companies to single drafts and batch research", async status => {
  const f = setup();
  f.db.repos.companies.setProfileStatus(f.company.id, status);
  const prepared = f.drafts.prepare(f.params);
  expect(prepared.parameters.companyId).toBe(f.company.id);
  const queued = await f.submission.submitBatch(f.item.id, [{ companyId: f.company.id, input }], `batch-${status}`);
  expect(queued.status).toBe("queued");
  expect(f.batch.getState(f.item.id)?.entries).toHaveLength(1);
  f.batch.dispose();
});
it("prepares without a run; rejects stale revision after editing and never queues it", async () => {
  const f = setup(); const prepared = f.drafts.prepare(f.params);
  expect(f.research.listRuns(f.item.id, f.company.id)).toEqual([]);
  f.drafts.update(prepared.draftRef, { ...f.params, focusScope: "芯片" });
  await expect(f.submission.submit(prepared, "stale")).rejects.toMatchObject({ code: "revision_changed" });
  expect(f.batch.getState(f.item.id)).toBeNull(); f.batch.dispose();
});
it("atomically persists one invocation receipt and returns it again after reconstruction", async () => {
  const f = setup(); const prepared = f.drafts.prepare(f.params);
  const first = await f.submission.submit(prepared, "once");
  expect(f.submission.adapter.snapshot(first.taskRef.taskId).presentation).toMatchObject({ text: expect.stringContaining("甲"), target: { viewId: "company" } });
  const again = new ResearchSubmission(new ResearchDrafts(f.db.repos.companyResearchProtocol, f.research), f.batch, f.profiles, f.research);
  expect((await again.submit(prepared, "once")).taskRef).toEqual(first.taskRef);
  expect(f.batch.getState(f.item.id)?.entries).toHaveLength(1); f.batch.dispose();
});
it("UI and action submissions normalize the same parameters through queue admission", async () => {
  const f = setup();
  const prepared = f.drafts.prepare({ ...f.params, focusScope: " 芯片 " });
  await f.submission.submit(prepared, "chat");
  const chatInput = f.batch.getState(f.item.id)!.entries[0]!.input;
  await f.batch.cancel(f.batch.getState(f.item.id)!.batchId);
  const ui = await f.submission.submitUi(f.item.id, [{ companyId: f.company.id, input: { ...input, focusScope: " 芯片 " } }]);
  expect(ui.entries[0]!.input).toEqual({ ...input, focusScope: "芯片" });
  expect(chatInput).toEqual(ui.entries[0]!.input); f.batch.dispose();
});
it("keeps cancelled receipts after queue cleanup and recovers pending receipts paused without dispatch", async () => {
  const f = setup();
  const first = await f.submission.submit(f.drafts.prepare(f.params), "cancelled");
  await f.batch.cancel(f.batch.getState(f.item.id)!.batchId);
  expect(f.batch.getState(f.item.id)).toBeNull();
  expect(f.submission.adapter.snapshot(first.taskRef.taskId)).toMatchObject({ status: "cancelled", cancellable: false, finishedAt: expect.any(String) });
  const second = await f.submission.submit(f.drafts.prepare(f.params), "paused");
  f.batch.dispose();
  expect(f.submission.adapter.snapshot(second.taskRef.taskId)).toMatchObject({ status: "paused", cancellable: true });
  expect(f.submission.adapter.snapshot(second.taskRef.taskId).finishedAt).toBeUndefined();
  f.research.dispose();
  const replacementResearch = new CompanyResearchService(f.db.repos, f.profiles, f.worker, { requestIdFactory: () => crypto.randomUUID() });
  const replacement = new CompanyResearchBatchService(f.db.repos, replacementResearch);
  const next = new ResearchSubmission(new ResearchDrafts(f.db.repos.companyResearchProtocol, replacementResearch), replacement, f.profiles, replacementResearch);
  replacement.recover();
  expect(next.adapter.find("paused")?.status).toBe("paused");
  expect(replacementResearch.listRuns(f.item.id, f.company.id)).toEqual([]); replacement.dispose();
});
it("keeps a failed second round readable, slices large raw content and rejects changed revisions", async () => {
  const f = setup(false); const raw = "证据 https://example.test/source\n".repeat(1000);
  f.worker.sendResearch = request => (async function* () {
    if (request.stage === "raw") yield { type: "completed", requestId: request.requestId, runId: request.runId, stage: "raw", text: raw } as const;
    else yield { type: "failed", requestId: request.requestId, runId: request.runId, stage: "structure", code: "structuring_failed", message: "company research structuring failed" } as const;
  })();
  const accepted = await f.submission.submit(f.drafts.prepare(f.params), "partial");
  await new Promise<void>(resolve => setImmediate(resolve));
  const task = f.submission.adapter.snapshot(accepted.taskRef.taskId);
  expect(task.status).toBe("failed"); expect(f.batch.getState(f.item.id)).toBeNull();
  expect(task.presentation).toMatchObject({ text: expect.stringContaining("原始报告仍可查看"), target: { viewId: "report" } });
  expect(task.finishedAt).toBeDefined(); expect(task.artifactRefs).toHaveLength(1);
  const ref = task.artifactRefs![0]!;
  const summary = JSON.parse(f.submission.adapter.read(ref, {}).data as string);
  expect(summary).toMatchObject({ failureStage: "structure", createdAt: expect.any(String), rawCompletedAt: expect.any(String), searchStatus: expect.any(String) });
  let text = ""; let cursor: string | undefined;
  do { const slice = f.submission.adapter.read(ref, { section: "raw", ...(cursor ? { cursor } : {}) }); expect(Buffer.byteLength(JSON.stringify(slice))).toBeLessThan(64000); text += slice.data; cursor = slice.nextCursor; } while (cursor);
  expect(text).toBe(raw);
  const run = f.research.listRuns(f.item.id, f.company.id)[0]!;
  f.db.repos.companyResearchRuns.retryStructuring(run.id);
  expect(() => f.submission.adapter.read(ref, { section: "raw" })).toThrow("revision_changed");
  f.db.repos.companyResearchRuns.failStructuring(run.id);
  const latest = f.research.getRun(f.item.id, f.company.id, run.id)!;
  const updated = artifactRef(latest);
  f.research.deleteRun(f.item.id, f.company.id, run.id);
  expect(() => f.submission.adapter.read(updated, { section: "raw" })).toThrow("not_found");
  f.batch.dispose();
});
it("rolls back both durable and in-memory admission when receipt persistence fails", async () => {
  const f = setup(); const prepared = f.drafts.prepare(f.params);
  const save = vi.spyOn(f.db.repos.companyResearchProtocol, "saveTask").mockImplementationOnce(() => { throw new Error("disk"); });
  await expect(f.submission.submit(prepared, "rollback")).rejects.toBeDefined();
  expect(f.batch.getState(f.item.id)).toBeNull();
  expect(f.db.repos.companyResearchBatches.getActive()).toBeUndefined();
  expect(f.db.repos.companyResearchProtocol.findTask("rollback")).toBeUndefined();
  save.mockRestore(); await f.submission.submit(prepared, "rollback");
  expect(f.batch.getState(f.item.id)?.entries).toHaveLength(1); f.batch.dispose();
});
it("binds a batch task to its exact admitted entries and leaves later queue additions alone", async () => {
  const f = setup();
  const second = f.db.repos.companies.upsert({ name: "乙" });
  const later = f.db.repos.companies.upsert({ name: "丙" });
  for (const candidate of [second, later]) { f.db.repos.companies.setProfileStatus(candidate.id, "ready"); f.db.repos.itemCompanies.add(f.item.id, candidate.id); }
  const accepted = await f.submission.submitBatch(f.item.id, [
    { companyId: f.company.id, input }, { companyId: second.id, input },
  ], "batch-once");
  expect(accepted.presentation).toMatchObject({ text: expect.stringContaining("半导体"), target: { viewId: "companies" } });
  const duplicate = await f.submission.submitBatch(f.item.id, [{ companyId: later.id, input }], "batch-once");
  expect(duplicate.taskRef).toEqual(accepted.taskRef);
  const laterTask = await f.submission.submitBatch(f.item.id, [{ companyId: later.id, input }], "batch-later");
  expect(f.batch.getState(f.item.id)?.entries).toHaveLength(3);
  await f.submission.adapter.cancel(accepted.taskRef.taskId);
  expect(f.submission.adapter.snapshot(accepted.taskRef.taskId)).toMatchObject({ status: "cancelled", cancellable: false });
  expect(f.submission.adapter.snapshot(laterTask.taskRef.taskId)).toMatchObject({ status: "running", cancellable: true });
  expect(f.batch.getState(f.item.id)?.entries.map(entry => entry.status)).toEqual(["cancelled", "cancelled", "running"]);
  f.batch.dispose();
});
