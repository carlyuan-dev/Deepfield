import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createCapabilityHostServices, getCapabilityTrace } from "@deepfield/capability-sdk";
import { configureTraceCollector, createTraceCollector, createTracePort, currentTrace, startTraceSpan, withTrace } from "@deepfield/base/trace/runtime";
import { scopeCapabilityTrace } from "../../apps/desktop/src/shared/capability-trace.js";
import type { CapabilityHostServices } from "@deepfield/capability-sdk";
import type { TraceEvent } from "@deepfield/base/trace";
import { createMeteredSearchProvider } from "@deepfield/base/search/runtime";
import { FakeAuditSink } from "@deepfield/tool-platform";
import { adoptDatabase } from "@deepfield/base/database/runtime";
import { createUsageRepository } from "@deepfield/base/usage/sqlite";
import { openTestDb } from "../../packages/application/src/testing/application-test-helpers.js";
import { makeSecrets } from "../../packages/application/src/chat/chat-service-helpers.js";
import { AgentWorkerClient } from "../../apps/desktop/src/main/agent-worker-client.js";
import { FakeEndpoint } from "../../apps/desktop/src/main/agent-worker-client-test-helpers.js";
import { WorkerCapabilityRegistry } from "../../apps/desktop/src/worker/capabilities/registry.js";
import { createCapabilityAgentRuntime } from "../../apps/desktop/src/worker/capabilities/agent-runtime.js";
import { createToolRuntime } from "../../apps/desktop/src/worker/tools/tool-runtime.js";
import { configureUsageRecorder, withUsageContext, modelUsagePort, snapshotIdentity } from "../../apps/desktop/src/shared/usage-collection.js";

afterEach(() => { configureTraceCollector(undefined); configureUsageRecorder(undefined); vi.unstubAllGlobals(); });

it("portable company entries keep host traces across queued sources, raw tools, structure repair and structure-only retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-package-"));
  const bundle = join(dir, "package");
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import {buildPackage} from ${JSON.stringify(pathToFileURL(resolve("capabilities/company-research/build.ts")).href)}; await buildPackage(${JSON.stringify(bundle)});`], { maxBuffer: 4 * 1024 * 1024 });
  const main = await import(pathToFileURL(join(bundle, "dist/main.js")).href);
  const workerModule = await import(pathToFileURL(join(bundle, "dist/worker.js")).href);
  const db = openTestDb(); const events: TraceEvent[] = [];
  const collector = createTraceCollector(event => { events.push(event); }); configureTraceCollector(collector);
  const usage = createUsageRepository(adoptDatabase(db.db).database); usage.initialize(new Date().toISOString());
  const usageIds = new Set<string>();
  configureUsageRecorder({ recordStart: async value => { usageIds.add(value.attemptId); usage.upsert(value); return true; }, recordFinish: async value => { usage.upsert(value); return true; } });
  const profiles = makeSecrets("PRIVATE_TRACE_SENTINEL");
  const search = await profiles.resolveActiveSearch(); let searches = 0;
  const fakeSearch = createMeteredSearchProvider({ usage: modelUsagePort, snapshotIdentity }, search, { transport: { async request() {
    searches++; return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from('{"search_result":[]}')]), destroy() {} };
  } } });
  const tools = createToolRuntime({ audit: new FakeAuditSink() });
  const runtime = createCapabilityAgentRuntime({ toolSessions: { ...tools, bindSearchProvider(id, _provider, limits) { tools.bindSearchProvider(id, fakeSearch, limits); } } });
  const rawCounts = new Map<string, number>(); let structures = 0; let llmCalls = 0; let allowStructure = false;
  const stagesByRequest = new Map<string, string>();
  let releaseRaw!: () => void; const rawGate = new Promise<void>(resolve => { releaseRaw = resolve; });
  const valid = JSON.stringify({ coreSummary: ["现有公开信息不足以形成可靠的核心判断。"], sections: [{ sectionId: "products_and_positioning", status: "not_found", summary: null, facts: [] }] });
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    llmCalls++; const scope = currentTrace()!;
    let delta: object; let finish = "stop";
    if (stagesByRequest.get(scope.requestId) === "raw") {
      const count = (rawCounts.get(scope.requestId) ?? 0) + 1; rawCounts.set(scope.requestId, count);
      if (count === 1) { await rawGate; delta = { role: "assistant", tool_calls: [{ index: 0, id: "search-call", type: "function", function: { name: "web_search", arguments: '{"query":"PRIVATE_TRACE_SENTINEL","maxResults":1}' } }] }; finish = "tool_calls"; }
      else delta = { role: "assistant", content: "# 公司调研\n## 1. 主要产品与定位\n公开信息不足，暂未找到可靠公开信息。" };
    } else { structures++; delta = { role: "assistant", content: allowStructure ? valid : "invalid-json" }; }
    return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const endpoint = new FakeEndpoint(); const registry = new WorkerCapabilityRegistry(value => endpoint.emit(value));
  const workerRegistrar = registry.begin("company-research");
  workerModule.bootstrap(workerRegistrar, createCapabilityHostServices({ "model.execution": { runtime }, "usage.context": withUsageContext })); workerRegistrar.ready();
  endpoint.postMessage = value => { const request = value as { requestId: string; input?: { stage?: string } }; if (request.input?.stage) stagesByRequest.set(request.requestId, request.input.stage); registry.handle(value); };
  const client = new AgentWorkerClient(endpoint);
  const operations = new Map<string, (args: unknown) => unknown>(); const cleanup: (() => unknown)[] = [];
  const registrar = { defer: (fn: () => unknown) => cleanup.push(fn), onReady() {}, register: (name: string, _input: unknown, _output: unknown, call: (args: unknown) => unknown) => operations.set(name, call),
    emit() {}, registerTopic() {}, registerAction() {}, registerViewProvider() {}, registerTaskProvider() {}, registerArtifactProvider() {}, registerFormProvider() {} };
  const item = db.repos.capabilityItems.create({ industry: "离线主题" });
  const companies = ["甲公司", "乙公司"].map(name => { const company = db.repos.companies.upsert({ name }); db.repos.itemCompanies.add(item.id, company.id); db.repos.companies.setProfileStatus(company.id, "ready"); return company; });
  const trace = createTracePort("company-research");
  main.bootstrap(registrar, createCapabilityHostServices({
    "database.v1": adoptDatabase(db.db).database,
    "tools.audit.v1": { version: 1, deleteByTraceIds: (ids: readonly string[]) => db.repos.toolExecutions.deleteByTraceIds(ids) },
    "model.configuration": { profiles, settings: { get: async () => ({}) }, onConfigurationChanged: () => () => {} },
    "model.execution": { transport: client, gateway: runtime.gateway }, "trace.v1": trace, "usage.context": withUsageContext, "document.save": {},
  }));
  const call = (name: string, args: unknown[]) => operations.get(name)!(args);
  const roots = [startTraceSpan("request", "source-one", {}, null), startTraceSpan("request", "source-two", {}, null)];
  const input = { moduleIds: ["products_and_positioning"], asOfDate: "2026-09-21" };
  try {
    await withTrace(roots[0]!.context, () => call("companyResearch.start", [item.id, companies[0]!.id, input]));
    await vi.waitFor(() => expect(llmCalls).toBe(1));
    await withTrace(roots[1]!.context, () => call("companyResearch.start", [item.id, companies[1]!.id, input]));
    releaseRaw();
    await vi.waitFor(() => expect(companies.every(company => ["structure_failed", "research_failed"].includes(db.repos.companyResearchRuns.listRuns(item.id, company.id)[0]?.status ?? ""))).toBe(true));
    expect(JSON.stringify(companies.map(company => db.repos.companyResearchRuns.listRuns(item.id, company.id)[0]))).not.toContain("research_failed");
    expect(structures).toBe(4); expect(searches).toBe(2);
    const first = db.repos.companyResearchRuns.listRuns(item.id, companies[0]!.id)[0]!;
    const before = db.repos.companyResearchRuns.getByIdForTarget(item.id, companies[0]!.id, first.id)!;
    const searchBeforeRetry = searches; const profilesBeforeRetry = profiles.searchCalls;
    allowStructure = true;
    await withTrace(roots[0]!.context, () => call("companyResearch.retryStructuring", [item.id, companies[0]!.id, first.id]));
    await vi.waitFor(() => expect(db.repos.companyResearchRuns.listRuns(item.id, companies[0]!.id)[0]?.status).toBe("completed"));
    expect(searches).toBe(searchBeforeRetry); expect(profiles.searchCalls).toBe(profilesBeforeRetry);
    const after = db.repos.companyResearchRuns.getByIdForTarget(item.id, companies[0]!.id, first.id)!;
    expect(after).toMatchObject({ attemptId: (before as any).attemptId, rawReportText: (before as any).rawReportText });
    const second = db.repos.companyResearchRuns.listRuns(item.id, companies[1]!.id)[0]!;
    await withTrace(roots[1]!.context, () => call("companyResearch.retryFailed", [item.id, companies[1]!.id, second.id, { ...input, focusScope: "新范围" }]));
    await vi.waitFor(() => expect(db.repos.companyResearchRuns.listRuns(item.id, companies[1]!.id)[0]?.status).toBe("completed"));
    expect(db.repos.companyResearchRuns.listRuns(item.id, companies[1]!.id)[0]).toMatchObject({ id: second.id });
    expect((db.repos.companyResearchRuns.listRuns(item.id, companies[1]!.id)[0] as any).attemptId).not.toBe((second as any).attemptId);
    expect(searches).toBe(searchBeforeRetry + 1);
    roots.forEach(root => root.end("handed_off")); await collector.close();
    const stages = events.filter(event => event.type === "span.start" && event.kind === "stage");
    expect(stages).toHaveLength(7);
    expect(stages.every(event => "artifactId" in event && typeof event.artifactId === "string" && !("evidenceAttemptId" in event))).toBe(true);
    expect(stages.filter(event => event.rootTraceId === roots[0]!.context.rootTraceId)).toHaveLength(3);
    expect(stages.filter(event => event.rootTraceId === roots[1]!.context.rootTraceId)).toHaveLength(4);
    expect(events.filter(event => event.type === "span.start" && event.kind === "model")).toHaveLength(llmCalls);
    expect(events.some(event => event.type === "span.start" && event.kind === "tool" && event.toolName === "web_search")).toBe(true);
    expect(new Set(events.filter(event => event.type === "usage.link").map(event => event.usageAttemptId))).toEqual(usageIds);
    expect(usageIds.size).toBe(llmCalls + searches);
    expect(events.some(event => event.type === "span.link" && event.links.length > 0)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_TRACE_SENTINEL");
  } finally { releaseRaw(); for (const dispose of cleanup.reverse()) await dispose(); await registry.dispose(); client.dispose(); trace.dispose(); db.cleanup(); await rm(dir, { recursive: true, force: true }); }
}, 60_000);


it("a document capability observes custom stages without changing results, errors or ownership", async () => {
  const events: TraceEvent[] = [];
  const collector = createTraceCollector(event => { events.push(event); }); configureTraceCollector(collector);
  const cleanup: (() => void)[] = [];
  const host = createCapabilityHostServices({ "trace.v1": createTracePort() });
  const services = scopeCapabilityTrace(host, "document-export", fn => cleanup.push(fn));
  const other = getCapabilityTrace(scopeCapabilityTrace(host, "image-export", fn => cleanup.push(fn)))!;
  const trace = getCapabilityTrace(services)!;
  let calls = 0;
  const failure = new Error("document_conversion_failed");
  const execute = async (services: CapabilityHostServices, fail = false) => {
    const port = getCapabilityTrace(services);
    const span = port?.start("stage", "document-request", { stage: "document.render_v2", artifactId: "document:1", runId: "shared-run", capabilityId: "forged" }, null);
    const work = async () => { calls++; await Promise.resolve(); if (fail) throw failure; return { pages: 2 }; };
    try { const result = await (port ? port.run(span?.context, work) : work()); span?.end("succeeded"); return result; }
    catch (error) { span?.end("failed", "execution_failed"); throw error; }
  };
  try {
    expect(await execute(services)).toEqual({ pages: 2 });
    const own = trace.find({ kind: "run", id: "shared-run" }); expect(own).toBeDefined();
    expect(other.find({ kind: "run", id: "shared-run", capabilityId: "document-export" })).toBeUndefined();
    await expect(execute(services, true)).rejects.toBe(failure);
    expect(await execute(createCapabilityHostServices({}))).toEqual({ pages: 2 });
    expect(await execute(createCapabilityHostServices({ "trace.v1": { version: 2 } }))).toEqual({ pages: 2 });
    cleanup.forEach(dispose => dispose());
    expect(await execute(services)).toEqual({ pages: 2 });
    expect(calls).toBe(5);
    await collector.close();
    expect(events.filter(event => event.type === "span.start")).toHaveLength(2);
    expect(events.filter(event => event.type === "span.end").map(event => event.status)).toEqual(["succeeded", "failed"]);
    expect(events.every(event => "capabilityId" in event && event.capabilityId === "document-export")).toBe(true);
    expect(events[0]).toMatchObject({ stage: "document.render_v2", artifactId: "document:1" });
  } finally { cleanup.forEach(dispose => dispose()); }
});
