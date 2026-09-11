import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import {
  CompanyResearchEventSchema, CompanyResearchStateSchema, CompanyResearchWorkerRequestSchema,
  getCompanyResearchTemplate,
  type CompanyResearchEvent, type CompanyResearchStage, type CompanyResearchWorkerEvent,
  type CompanyResearchWorkerRequest, type StartCompanyResearchInput,
} from "@deepfield/contracts";
import { CompanyResearchService, CompanyResearchServiceError } from "./company-research-service.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";

const dbs: TestDb[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const db of dbs.splice(0)) db.cleanup(); });
const input: StartCompanyResearchInput = {
  direction: "product_and_technology", focusScope: "  新品  ", asOfDate: "2026-09-11",
};
const raw = "原始报告：[产品公告](https://example.com/product)";
function candidate() {
  return {
    coreSummary: ["公司已发布产品"],
    sections: ["products_and_positioning", "technology_and_metrics", "development_and_readiness", "competitive_position", "constraints_and_roadmap"].map((sectionId, i) => i === 0 ? {
      sectionId, status: "found", summary: "已发布产品", facts: [{
        text: "公司发布了产品", timeContext: null, claimType: "reported_fact",
        source: { title: "产品公告", url: "https://example.com/product" },
      }],
    } : { sectionId, status: "not_found", summary: null, facts: [] }),
  };
}

// Controllable transport; persistence and Harness remain real.
function workerDouble() {
  const requests: CompanyResearchWorkerRequest[] = [];
  const queues = new Map<string, { events: unknown[]; wake: (() => void) | undefined; ended: boolean }>();
  const cancellations: unknown[] = [];
  const worker = {
    requests, cancellations,
    sendResearch(request: CompanyResearchWorkerRequest): AsyncIterable<CompanyResearchWorkerEvent> {
      requests.push(structuredClone(request));
      const queue = { events: [] as unknown[], ended: false, wake: undefined as (() => void) | undefined };
      queues.set(request.requestId, queue);
      return (async function* () {
        while (true) {
          if (queue.events.length) yield queue.events.shift() as CompanyResearchWorkerEvent;
          else if (queue.ended) return;
          else await new Promise<void>((resolve) => { queue.wake = resolve; });
        }
      })();
    },
    push(request: CompanyResearchWorkerRequest, event: unknown) {
      const queue = queues.get(request.requestId)!;
      queue.events.push(event); queue.wake?.();
    },
    finish(request: CompanyResearchWorkerRequest, text: string) {
      worker.push(request, { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "completed", text });
    },
    end(request: CompanyResearchWorkerRequest) {
      const queue = queues.get(request.requestId)!;
      queue.ended = true; queue.wake?.();
    },
    cancelResearch(requestId: string, runId: string, stage: CompanyResearchStage) {
      cancellations.push({ requestId, runId, stage });
      const request = requests.find((request) => request.requestId === requestId)!;
      worker.push(request, { requestId, runId, stage, type: "cancelled" });
    },
  };
  return worker;
}
async function flush() { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 30; i++) { if (check()) return; await flush(); }
  expect(check()).toBe(true);
}
function fixture(options: { key?: string; now?: Date } = {}) {
  const db = openTestDb(); dbs.push(db);
  const item = db.repos.capabilityItems.create({ industry: "智能眼镜", researchScope: "中国消费级市场" });
  const initial = db.repos.companies.upsert({ name: "小米" });
  const company = db.repos.companies.update(initial.id, {
    name: "小米", legalName: "小米集团", aliases: ["Xiaomi"], headquarters: "中国北京",
    foundedAt: "2010-04-06", officialWebsite: "https://www.mi.com",
    stockListings: [{ exchange: "HKEX", ticker: "1810" }], businessTags: ["消费电子"],
  })!;
  db.repos.itemCompanies.add(item.id, company.id, "重点候选");
  const worker = workerDouble(); let sequence = 0;
  const secrets = { get: () => options.key ?? "sk-test" };
  const service = new CompanyResearchService(db.repos, secrets, worker, {
    requestIdFactory: () => `request-${++sequence}`, now: () => options.now ?? new Date(2026, 8, 11, 0, 15),
  });
  const events: CompanyResearchEvent[] = [];
  service.subscribe((event) => events.push(event));
  const start = () => service.start(item.id, company.id, input);
  const detail = (id: string) => service.getRun(item.id, company.id, id);
  const toStructure = async () => {
    const run = start(); await waitFor(() => worker.requests.length === 1);
    worker.finish(worker.requests[0]!, raw); await waitFor(() => worker.requests.length === 2);
    return run;
  };
  return { db, item, company, worker, service, events, secrets, start, detail, toStructure };
}

describe("CompanyResearchService two-stage orchestration", () => {
  it.each([false, true])("cleans up web search failure without structuring or leaking provider text (malformed=%s)", async (malformed) => {
    const f = fixture(); const run = f.start();
    await waitFor(() => f.worker.requests.length === 1);
    const request = f.worker.requests[0]!;
    f.worker.push(request, { requestId: request.requestId, runId: run.id, stage: "raw", type: "failed", code: "web_search_failed", message: malformed ? "private refusal" : "company research web search failed" });
    await waitFor(() => !f.service.isRunning());
    expect(f.worker.requests).toHaveLength(1);
    expect(f.detail(run.id)).toBeUndefined();
    expect(f.service.getState(f.item.id, f.company.id).globalActiveRun).toBeNull();
    expect(f.events.at(-1)).toEqual({ type: "state_changed", itemId: f.item.id, companyId: f.company.id, runId: run.id, outcome: malformed ? "research_failed" : "web_search_failed" });
    expect(JSON.stringify(f.events)).not.toContain("private refusal");
    expect(f.events.some((event) => event.type === "text_delta")).toBe(false);
  });

  it("commits raw before a new structure request, holds reservation, and publishes only durable states/raw deltas", async () => {
    const f = fixture(); const seen: unknown[] = []; const boundary: unknown[] = [];
    f.service.subscribe((event) => {
      if (event.type !== "state_changed") return;
      seen.push(f.detail(event.runId)?.status);
      if (f.detail(event.runId)?.status === "structuring") {
        boundary.push(f.service.isRunning(), f.worker.requests.length);
        try { f.start(); boundary.push("unexpected start"); } catch { boundary.push("reserved"); }
      }
    });
    const run = f.start(); await waitFor(() => f.worker.requests.length === 1);
    const request = f.worker.requests[0]!;
    f.worker.push(request, { requestId: request.requestId, runId: run.id, stage: "raw", type: "text_delta", delta: "草稿" });
    await waitFor(() => f.service.getState(f.item.id, f.company.id).active?.draftText === "草稿");
    f.worker.finish(request, raw); await waitFor(() => f.worker.requests.length === 2);
    expect(f.detail(run.id)).toMatchObject({ status: "structuring", rawReportText: raw, structuringAttempts: 1 });
    expect(boundary).toEqual([true, 1, "reserved"]);
    expect(f.worker.requests[1]).toMatchObject({ kind: "company-research.structure.run", stage: "structure", rawReportText: raw });
    expect(f.worker.requests[1]!.requestId).not.toBe(request.requestId);
    expect(f.worker.requests.every((r) => Value.Check(CompanyResearchWorkerRequestSchema, r))).toBe(true);
    expect(request.context).toEqual({
      currentDate: "2026-09-11", companyName: "小米", legalName: "小米集团", aliases: ["Xiaomi"],
      headquarters: "中国北京", foundedAt: "2010-04-06", officialWebsite: "https://www.mi.com",
      stockListings: [{ exchange: "HKEX", ticker: "1810" }], businessTags: ["消费电子"],
      topicName: "智能眼镜", topicScope: "中国消费级市场", companyNote: "重点候选",
      direction: input.direction, focusScope: "新品", asOfDate: "2026-09-11",
    });
    f.worker.finish(f.worker.requests[1]!, JSON.stringify(candidate())); await waitFor(() => !f.service.isRunning());
    expect(f.detail(run.id)).toMatchObject({ status: "completed", rawReportText: raw, structuredContent: candidate() });
    expect(seen).toEqual(["researching", "structuring", "completed"]);
    expect(f.events.map((event) => event.type)).toEqual(["state_changed", "text_delta", "state_changed", "state_changed"]);
    expect(f.events.every((event) => Value.Check(CompanyResearchEventSchema, event))).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain("coreSummary");
    expect(f.db.repos.companies.getById(f.company.id)).toEqual(f.company);
    expect(f.db.repos.capabilityItems.getById(f.item.id)).toEqual(f.item);
    expect(() => f.service.retryStructuring(f.item.id, f.company.id, run.id)).toThrow(CompanyResearchServiceError);
  });

  it.each(["failed", "cancelled", "empty", "blank", "throw", "malformed"])("removes raw run on %s with a safe transient outcome", async (failure) => {
    const f = fixture();
    if (failure === "throw") vi.spyOn(f.worker, "sendResearch").mockImplementation(() => { throw Error("secret-provider-detail"); });
    const run = f.start(); await flush(); const request = f.worker.requests[0];
    if (request) {
      if (failure === "empty") f.worker.end(request);
      else if (failure === "blank") f.worker.finish(request, "  ");
      else if (failure === "cancelled") await f.service.cancel(run.id);
      else f.worker.push(request, { requestId: request.requestId, runId: run.id, stage: "raw", type: "failed", code: "research_failed", message: failure === "malformed" ? "secret-provider-detail" : "company research failed" });
    }
    await waitFor(() => !f.service.isRunning());
    expect(f.detail(run.id)).toBeUndefined(); expect(f.service.listRuns(f.item.id, f.company.id)).toEqual([]);
    expect(f.events.at(-1)).toEqual({ type: "state_changed", itemId: f.item.id, companyId: f.company.id, runId: run.id, outcome: failure === "cancelled" ? "cancelled" : "research_failed" });
    expect(Value.Check(CompanyResearchEventSchema, f.events.at(-1))).toBe(true);
    expect(Value.Check(CompanyResearchEventSchema, { ...f.events.at(-1), outcome: "secret-provider-detail" })).toBe(false);
    expect(JSON.stringify(f.events)).not.toContain("secret-provider-detail");
  });

  it.each(["failed", "cancelled", "empty", "invalid-json", "wrong-order", "wrong-source", "write-failure", "dispatch-failure"])("preserves raw on structure %s", async (failure) => {
    const f = fixture();
    if (failure === "dispatch-failure") {
      const original = f.worker.sendResearch.bind(f.worker);
      vi.spyOn(f.worker, "sendResearch").mockImplementation((request) => {
        if (request.stage === "structure") throw Error("secret-provider-detail");
        return original(request);
      });
    }
    const run = f.start(); await waitFor(() => f.worker.requests.length === 1);
    f.worker.finish(f.worker.requests[0]!, raw); await flush(); const request = f.worker.requests[1];
    if (request) {
      if (failure === "cancelled") await f.service.cancel(run.id);
      else if (failure === "empty") f.worker.end(request);
      else if (failure === "failed") f.worker.push(request, { requestId: request.requestId, runId: run.id, stage: "structure", type: "failed", code: "structuring_failed", message: "company research structuring failed" });
      else {
        const content = candidate();
        if (failure === "wrong-order") content.sections.reverse();
        if (failure === "wrong-source") content.sections[0]!.facts[0]!.source.title = "Invented title";
        if (failure === "write-failure") {
          const complete = f.db.repos.companyResearchRuns.completeStructured;
          vi.spyOn(f.db.repos.companyResearchRuns, "completeStructured").mockImplementation((id, content) => {
            complete(id, content); throw Error("secret-provider-detail");
          });
        }
        f.worker.finish(request, failure === "invalid-json" ? "not-json" : JSON.stringify(content));
      }
    }
    await waitFor(() => !f.service.isRunning());
    expect(f.detail(run.id)).toMatchObject({ status: "structure_failed", rawReportText: raw, lastFailureCode: "structuring_failed" });
    expect(f.detail(run.id)).not.toHaveProperty("structuredContent"); expect(f.events.at(-1)).not.toHaveProperty("outcome");
    expect(JSON.stringify(f.events)).not.toContain("secret-provider-detail"); expect(f.worker.requests.length).toBeLessThanOrEqual(2);
  });

  it("retries only saved raw, context and template after live company/topic edits", async () => {
    const f = fixture(); const run = await f.toStructure(); await f.service.cancel(run.id);
    const original = structuredClone(f.worker.requests[1]!);
    // A historical snapshot can differ from the current compiled registry.
    original.template = { ...original.template, title: "历史模板标题" };
    f.db.db.prepare("UPDATE company_research_runs SET template_snapshot_json = ? WHERE id = ?")
      .run(JSON.stringify(original.template), run.id);
    f.db.repos.companies.update(f.company.id, { name: "新名称", aliases: ["Changed"] });
    f.db.repos.capabilityItems.update(f.item.id, { industry: "新主题", researchScope: "新范围" });
    const retried = f.service.retryStructuring(f.item.id, f.company.id, run.id);
    expect(retried).toMatchObject({ status: "structuring", structuringAttempts: 2 });
    await waitFor(() => f.worker.requests.length === 3);
    expect(f.worker.requests[2]).toEqual({ ...original, requestId: "request-3" });
    expect(() => f.start()).toThrow("already running");
    f.worker.finish(f.worker.requests[2]!, JSON.stringify(candidate())); await waitFor(() => !f.service.isRunning());
    expect(f.detail(run.id)).toMatchObject({ status: "completed", structuringAttempts: 2 });
  });

  it("does not dispatch structure if raw persistence rolls back", async () => {
    const f = fixture(); const completeRaw = f.db.repos.companyResearchRuns.completeRaw;
    vi.spyOn(f.db.repos.companyResearchRuns, "completeRaw").mockImplementation((id, text) => { completeRaw(id, text); throw Error("disk error"); });
    const run = f.start(); await waitFor(() => f.worker.requests.length === 1);
    f.worker.finish(f.worker.requests[0]!, raw); await waitFor(() => !f.service.isRunning());
    expect(f.detail(run.id)).toBeUndefined(); expect(f.worker.requests).toHaveLength(1);
  });

  it.each(["raw", "structure"] as const)("cancels %s with exact identity and suppresses late completion", async (stage) => {
    const f = fixture(); const run = stage === "raw" ? f.start() : await f.toStructure();
    await waitFor(() => f.worker.requests.length === (stage === "raw" ? 1 : 2)); const request = f.worker.requests.at(-1)!;
    vi.spyOn(f.worker, "cancelResearch").mockImplementation((requestId, runId, actualStage) => {
      f.worker.cancellations.push({ requestId, runId, stage: actualStage });
      f.worker.finish(request, stage === "raw" ? raw : JSON.stringify(candidate()));
    });
    await f.service.cancel(run.id); await waitFor(() => !f.service.isRunning());
    expect(f.worker.cancellations).toEqual([{ requestId: request.requestId, runId: run.id, stage }]);
    expect(f.detail(run.id)?.status).toBe(stage === "raw" ? undefined : "structure_failed");
  });

  it("cancels at the durable raw boundary without sending a structure request", async () => {
    const f = fixture(); let cancellation: Promise<void> | undefined;
    f.service.subscribe((event) => {
      if (event.type === "state_changed" && f.detail(event.runId)?.status === "structuring") cancellation = f.service.cancel(event.runId);
    });
    const run = f.start(); await waitFor(() => f.worker.requests.length === 1);
    f.worker.finish(f.worker.requests[0]!, raw); await waitFor(() => !f.service.isRunning()); await cancellation;
    expect(f.detail(run.id)).toMatchObject({ status: "structure_failed", rawReportText: raw });
    expect(f.worker.requests).toHaveLength(1); expect(f.worker.cancellations).toEqual([]);
  });

  it("isolates throwing/reentrant listeners and never clears a new run on old completion", async () => {
    const f = fixture(); let nextId: string | undefined;
    f.service.subscribe(() => { throw Error("closed renderer"); });
    f.service.subscribe((event) => {
      if (event.type === "state_changed" && f.detail(event.runId)?.status === "completed") nextId = f.start().id;
    });
    const run = await f.toStructure(); const request = f.worker.requests[1]!;
    f.worker.finish(request, JSON.stringify(candidate())); f.worker.finish(request, "late invalid candidate");
    await waitFor(() => f.worker.requests.length === 3);
    expect(f.detail(run.id)?.status).toBe("completed");
    expect(f.service.getState(f.item.id, f.company.id).globalActiveRun?.runId).toBe(nextId);
    await f.service.cancel(nextId!);
  });

  it("ignores foreign request/run/stage events while allowing the matching result", async () => {
    const f = fixture(); const run = f.start(); await waitFor(() => f.worker.requests.length === 1); const request = f.worker.requests[0]!;
    for (const identity of [{ requestId: "other" }, { runId: "other" }, { stage: "structure" }]) {
      f.worker.push(request, { requestId: request.requestId, runId: run.id, stage: "raw", type: "completed", text: "foreign", ...identity });
    }
    f.worker.finish(request, raw); await waitFor(() => f.worker.requests.length === 2);
    expect(f.detail(run.id)).toMatchObject({ status: "structuring", rawReportText: raw }); await f.service.cancel(run.id);
  });

  it("returns body-free history/global occupancy and scoped details without mutable active aliases", async () => {
    const f = fixture(); const other = f.db.repos.capabilityItems.create({ industry: "其他" }); f.db.repos.itemCompanies.add(other.id, f.company.id);
    const run = await f.toStructure();
    expect(f.service.getState(other.id, f.company.id)).toEqual({ runs: [], globalActiveRun: { runId: run.id, itemId: f.item.id, companyId: f.company.id, stage: "structure" } });
    expect(f.service.getRun(other.id, f.company.id, run.id)).toBeUndefined();
    expect(() => f.service.retryStructuring(other.id, f.company.id, run.id)).toThrow();
    const selected = f.service.getState(f.item.id, f.company.id);
    expect(Value.Check(CompanyResearchStateSchema, selected)).toBe(true);
    expect(selected.active!.run).not.toHaveProperty("rawReportText"); expect(selected.active!.run).not.toHaveProperty("researchContext");
    selected.active!.run.status = "researching";
    expect(f.service.getState(f.item.id, f.company.id).active!.run.status).toBe("structuring");
    await f.service.cancel(run.id);
    const history = f.service.listRuns(f.item.id, f.company.id);
    expect(history[0]).toMatchObject({ id: run.id, status: "structure_failed" }); expect(history[0]).not.toHaveProperty("rawReportText");
    f.db.repos.itemCompanies.remove(f.item.id, f.company.id);
    expect(() => f.detail(run.id)).toThrow(CompanyResearchServiceError);
  });

  it.each(["2026-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-09-12", "0000-01-01"])("rejects impossible/future local date %s", (asOfDate) => {
    const f = fixture(); expect(() => f.service.start(f.item.id, f.company.id, { ...input, asOfDate })).toThrow("invalid company research input"); expect(f.service.isRunning()).toBe(false);
  });
  it.each([undefined, "   ", "新产品"])("accepts optional focus %s and a real leap-day date", async (focusScope) => {
    const f = fixture(); const run = f.service.start(f.item.id, f.company.id, { direction: input.direction, asOfDate: "2024-02-29", ...(focusScope === undefined ? {} : { focusScope }) });
    expect(run).toMatchObject({ asOfDate: "2024-02-29" }); expect(run.focusScope).toBe(focusScope?.trim() || undefined); await f.service.cancel(run.id);
  });
  it("uses the real local day even while UTC is still the previous day", async () => {
    vi.stubEnv("TZ", "Asia/Shanghai");
    const f = fixture({ now: new Date("2026-09-10T16:15:00.000Z") });
    const run = f.start(); await waitFor(() => f.worker.requests.length === 1);
    expect(f.worker.requests[0]!.context.currentDate).toBe("2026-09-11");
    expect(f.worker.requests[0]!.context.asOfDate).toBe("2026-09-11");
    await f.service.cancel(run.id);
    expect(() => f.service.start(f.item.id, f.company.id, { ...input, asOfDate: "2026-09-12" })).toThrow("invalid company research input");
  });
  it("rejects missing key, invalid target and invalid input without occupancy", () => {
    const f = fixture({ key: " " }); expect(f.start).toThrow("api key");
    expect(() => f.service.start("missing", f.company.id, input)).toThrow("target not found");
    expect(() => f.service.start(f.item.id, f.company.id, { ...input, focusScope: "x".repeat(1001) })).toThrow("invalid company research input"); expect(f.service.isRunning()).toBe(false);
  });

  it("sanitizes credential lookup errors without leaving a run", () => {
    const f = fixture();
    vi.spyOn(f.secrets, "get").mockImplementation(() => { throw Error("secret-provider-detail"); });
    expect(f.start).toThrow(CompanyResearchServiceError);
    expect(f.start).not.toThrow("secret-provider-detail");
    expect(f.service.isRunning()).toBe(false);
  });

  it.each(["getState", "listRuns", "getRun"] as const)("sanitizes corrupt persisted content through %s", (method) => {
    const f = fixture();
    vi.spyOn(f.db.repos.companyResearchRuns, "getActive").mockImplementation(() => { throw Error("private persisted content"); });
    vi.spyOn(f.db.repos.companyResearchRuns, "listRuns").mockImplementation(() => { throw Error("private persisted content"); });
    vi.spyOn(f.db.repos.companyResearchRuns, "getByIdForTarget").mockImplementation(() => { throw Error("private persisted content"); });
    const read = () => f.service[method](f.item.id, f.company.id, "missing");
    expect(read).toThrow("company research report could not be read");
    expect(read).not.toThrow("private persisted content");
  });

  it("bounds accumulated raw deltas and never forwards structure candidate deltas", async () => {
    const f = fixture(); const run = f.start(); await waitFor(() => f.worker.requests.length === 1);
    const request = f.worker.requests[0]!;
    f.worker.push(request, { requestId: request.requestId, runId: run.id, stage: "raw", type: "text_delta", delta: "x".repeat(1_000_000) });
    f.worker.push(request, { requestId: request.requestId, runId: run.id, stage: "raw", type: "text_delta", delta: "overflow" });
    await waitFor(() => !f.service.isRunning());
    expect(f.detail(run.id)).toBeUndefined();
    expect(f.events.filter((event) => event.type === "text_delta")).toHaveLength(1);
    const next = f.start(); await waitFor(() => f.worker.requests.length === 2);
    f.worker.finish(f.worker.requests[1]!, raw); await waitFor(() => f.worker.requests.length === 3);
    const structure = f.worker.requests[2]!;
    f.worker.push(structure, { requestId: structure.requestId, runId: next.id, stage: "structure", type: "text_delta", delta: "private candidate" });
    await waitFor(() => !f.service.isRunning());
    expect(f.detail(next.id)).toMatchObject({ status: "structure_failed", rawReportText: raw });
    expect(JSON.stringify(f.events)).not.toContain("private candidate");
  });

  it.each(["raw", "structure"] as const)("cleans up %s when cancellation transport throws", async (stage) => {
    const f = fixture(); const run = stage === "raw" ? f.start() : await f.toStructure();
    await waitFor(() => f.worker.requests.length === (stage === "raw" ? 1 : 2));
    vi.spyOn(f.worker, "cancelResearch").mockImplementation(() => { throw Error("transport unavailable"); });
    await f.service.cancel(run.id);
    expect(f.service.isRunning()).toBe(false);
    expect(f.detail(run.id)?.status).toBe(stage === "raw" ? undefined : "structure_failed");
    // Delayed result from the abandoned transport cannot overwrite the terminal.
    f.worker.finish(f.worker.requests.at(-1)!, stage === "raw" ? raw : JSON.stringify(candidate())); await flush();
    expect(f.detail(run.id)?.status).toBe(stage === "raw" ? undefined : "structure_failed");
  });

  it("protects snapshots from caller and subscriber mutations, including cancellation before dispatch", async () => {
    const f = fixture();
    f.service.subscribe((event) => { if (event.type === "state_changed") event.runId = "mutated"; });
    const observed: string[] = [];
    f.service.subscribe((event) => { if (event.type === "state_changed") observed.push(event.runId); });
    const run = f.start(); run.researchContext.companyName = "mutated";
    await waitFor(() => f.worker.requests.length === 1);
    expect(f.worker.requests[0]!.context.companyName).toBe("小米");
    expect(observed).toEqual([run.id]);
    await f.service.cancel(run.id);
    let pending: Promise<void> | undefined;
    f.service.subscribe((event) => {
      if (event.type === "state_changed" && f.detail(event.runId)?.status === "researching") pending = f.service.cancel(event.runId);
    });
    const cancelled = f.start(); await pending;
    expect(f.detail(cancelled.id)).toBeUndefined(); expect(f.worker.requests).toHaveLength(1);
    expect(f.service.isRunning()).toBe(false);
  });

  it("rejects startup cleanup during an owned stage without dropping its reservation", async () => {
    const f = fixture(); const run = await f.toStructure();
    expect(() => f.service.cleanupAbandoned()).toThrow("already running");
    expect(f.service.isRunning()).toBe(true);
    expect(f.detail(run.id)?.status).toBe("structuring"); await f.service.cancel(run.id);
  });

  it.each(["researching", "structuring"])("recovers persisted %s with counts without rerunning Worker", (status) => {
    const f = fixture(); const normalized = { ...input, focusScope: "新品" };
    const run = f.db.repos.companyResearchRuns.createResearching(f.item.id, f.company.id, normalized, {
      ...normalized, currentDate: "2026-09-11", companyName: f.company.name, topicName: f.item.industry,
    }, getCompanyResearchTemplate(input.direction));
    if (status === "structuring") f.db.repos.companyResearchRuns.completeRaw(run.id, raw);
    expect(f.service.isRunning()).toBe(true); expect(() => f.start()).toThrow("already running");
    expect(f.service.cleanupAbandoned()).toEqual({ deletedResearching: status === "researching" ? 1 : 0, failedStructuring: status === "structuring" ? 1 : 0 });
    expect(f.detail(run.id)?.status).toBe(status === "researching" ? undefined : "structure_failed"); expect(f.worker.requests).toEqual([]);
  });
});
