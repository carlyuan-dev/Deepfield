import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { Readable } from "node:stream";
import { ProviderHttpClient } from "../../../packages/retrieval/src/provider-http-client.js";
import { createDoubaoProvider } from "../../../packages/retrieval/src/providers/doubao.js";
import { createTavilyProvider } from "../../../packages/retrieval/src/providers/tavily.js";
import { createSearchWebDefinition } from "../../../packages/retrieval/src/search-tool.js";
import { createReadWebpageDefinition } from "../../../packages/retrieval/src/read-webpage-tool.js";
import { ResourceStore } from "../../../packages/retrieval/src/resource-store.js";
import { Value } from "typebox/value";
import { ResearchEvidenceViewSchema } from "../contracts/research-evidence.js";
import { FakeAuditSink, FakeRetryClock, ToolBudgetLedger, ToolPolicy, ToolRegistry, ToolRunner, ToolSet } from "@deepfield/tool-platform";
import type { CapabilityWorkerEvent } from "@deepfield/capability-sdk";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts";
import { createRepositories, migrate } from "../../../packages/persistence/src/testing/repositories.js";
import { evidenceHash, evidenceBytes } from "../persistence/research-evidence-data.js";
import { PiModelGateway } from "../../../apps/desktop/src/shared/model-gateway.js";
import { defaultPiRuntime } from "../../../apps/desktop/src/worker/agent/pi-default-runtime.js";
import { createPiAgentTools } from "../../../apps/desktop/src/worker/tools/pi-tool-adapter.js";
import { createCapabilityAgentRuntime } from "../../../apps/desktop/src/worker/capabilities/agent-runtime.js";
import { WorkerCapabilityRegistry } from "../../../apps/desktop/src/worker/capabilities/registry.js";
import { activate } from "../worker.js";
import { createCompanyResearchWorkerClient } from "../worker-client.js";
import { CompanyResearchService } from "../application/company-research-service.js";
import { createCompanyResearchTemplate } from "../contracts/index.js";
import { validateStructuredResearch } from "../application/company-research-harness.js";
afterEach(() => vi.unstubAllGlobals());
function response(text: string, call: false | "web_search" | "read_webpage" = false): Response {
  const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: call === "web_search" ? "search_call" : "fetch_call", type: "function", function: { name: call, arguments: JSON.stringify(call === "web_search" ? { query: "公司" } : { url: "https://a.test/source" }) } }] } : { role: "assistant", content: text };
  return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
it.each(["existing", "doubao", "tavily", "redirect"])("real executor → activate/registry/client → SQLite freezes actual text and dates (%s), and ordinary/repair/manual retry dispatch the same packet", async (dateProvider) => {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys = ON"); migrate(db);
  const repos = createRepositories(db);
  const item = repos.capabilityItems.create({ industry: "智能眼镜" }); const company = repos.companies.upsert({ name: "甲公司" }); repos.itemCompanies.add(item.id, company.id);
  let llm: LlmRuntimeSnapshot = { id: "fixture", name: "fixture", provider: "custom", protocol: "openai_compatible", modelId: "fixture", baseUrl: "https://fixture.invalid/v1", contextWindow: 128000, apiKey: "local-fixture" };
  const search = { id: "search", name: "search", provider: "zhipu" as const, baseUrl: "https://fixture.invalid", apiKey: "local-search", options: { searchEngine: "search_std" } };
  const raw = "# 调研报告\n## 1. 主要产品与定位\n[甲来源](https://a.test/source)\n## 2. 核心技术与指标\n本次未找到。\n## 3. 研发与产品阶段\n本次未找到。\n## 4. 竞争力与替代方案\n本次未找到。"; const material = "实际发送的中文检索依据🌱".repeat(1800);
  const requests: any[] = []; const structureRequests: any[] = []; let rawCalls = 0; let searchCalls = 0; let fetchCalls = 0; let structureCalls = 0;
  const template = createCompanyResearchTemplate(["products_and_positioning", "technology_and_metrics", "development_and_readiness", "competitive_position"]);
  const valid = JSON.stringify({ coreSummary: ["现有公开信息不足以形成可靠的核心判断。"], sections: template.sections.map(s => ({ sectionId: s.sectionId, status: "not_found", summary: null, facts: [] })) });
  vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); requests.push(body);
    if (body.messages[0].content.includes("company-research-structure")) {
      structureRequests.push(body); structureCalls++;
      return response(structureCalls <= 2 ? "{bad json" : valid);
    }
    rawCalls++; return response(raw, rawCalls === 1 ? "web_search" : rawCalls === 2 ? "read_webpage" : false);
  });
  const tools = new ToolRegistry();
  const rawDate = "2026-08-22T09:16:00+08:00";
  if (dateProvider === "doubao" || dateProvider === "tavily") {
    const client = new ProviderHttpClient({ endpoint: { origin: "https://api.tavily.com", pathPrefix: "/search" }, transport: { async request() {
      searchCalls++;
      const payload = dateProvider === "doubao" ? { Result: { WebResults: [{ Title: "甲来源", Url: "https://a.test/source", Snippet: "公开资料", PublishTime: rawDate }] } } : { results: [{ title: "甲来源", url: "https://a.test/source", content: "公开资料", published_date: rawDate }] };
      return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from(JSON.stringify(payload))]), destroy() {} };
    } } });
    tools.register(createSearchWebDefinition(dateProvider === "doubao" ? createDoubaoProvider({ client, token: "local-fixture" }) : createTavilyProvider({ client, token: "local-fixture" })));
  } else {
  tools.register({ identity: { name: "web_search", version: 1 }, label: "Search", description: "Fixture search", inputSchema: Type.Object({ query: Type.String() }), outputSchema: Type.Any(), effect: "network.read.public", timeoutMs: 1000, retry: { maxRetries: 0, backoffMs: 0 }, concurrency: 1, meter: { category: "search", countsBytes: false, countsTime: false }, model: { formatOutput: value => JSON.stringify(value) }, execute: async () => { searchCalls++; return { results: [{ title: "甲来源", url: "https://a.test/source", snippet: material }] }; } });
  }
  if (dateProvider === "redirect") tools.register(createReadWebpageDefinition({ store: new ResourceStore(), transport: { async fetch(url) {
    fetchCalls++; expect(url).toBe("https://a.test/source");
    const body = Buffer.from('<html><head><title>甲来源</title><link rel="canonical" href="https://c.test/canonical"></head><body><main><p>实际重定向网页正文</p></main></body></html>');
    return { statusCode: 200, finalUrl: "https://b.test/final", contentType: "text/html", body, decompressedBytes: body.length, sha256: evidenceHash(body.toString()) };
  } } }));
  else tools.register({ identity: { name: "read_webpage", version: 1 }, label: "Fetch", description: "Fixture webpage", inputSchema: Type.Object({ url: Type.String() }), outputSchema: Type.Any(), effect: "network.read.public", timeoutMs: 1000, retry: { maxRetries: 0, backoffMs: 0 }, concurrency: 1, meter: { category: "fetch", countsBytes: false, countsTime: false }, model: { formatOutput: value => JSON.stringify(value) }, execute: async () => { fetchCalls++; return { title: "甲来源", url: "https://a.test/source", text: "实际提取网页正文" }; } });
  const budget = new ToolBudgetLedger({ maxCalls: 20, categoryCalls: { search: 10, fetch: 10 } });
  const runner = new ToolRunner({ registry: tools, policy: new ToolPolicy(), budget, audit: new FakeAuditSink(), clock: new FakeRetryClock() });
  const sessions = { createAgentTools: (context: any) => createPiAgentTools(tools, runner, { ...context, toolSet: new ToolSet(["web_search", "read_webpage"].map(name => ({ identity: { name, version: 1 }, actor: "capability" as const, effect: "network.read.public" as const }))) }), bindSearchProvider() {}, budgetSnapshot: () => budget.snapshot(), recordSynthetic: async () => undefined, releaseTrace: () => true };
  const gateway = new PiModelGateway(); const runtime = createCapabilityAgentRuntime({ runtime: defaultPiRuntime(gateway), toolSessions: sessions, gateway });
  const queues = new Map<string, { items: CapabilityWorkerEvent[]; wake?: () => void }>();
  const registry = new WorkerCapabilityRegistry(event => { const e = event as CapabilityWorkerEvent; const q = queues.get(e.requestId)!; q.items.push(e); q.wake?.(); });
  const registrar = registry.begin("company-research"); activate(registrar, { runtime, withUsage: (_context, work) => work() }); registrar.ready();
  const client = createCompanyResearchWorkerClient({
    sendCapability(request, validate) {
      const q: { items: CapabilityWorkerEvent[]; wake?: () => void } = { items: [] }; queues.set(request.requestId, q); registry.handle(request);
      return (async function* () { for (;;) { if (!q.items.length) await new Promise<void>(resolve => { q.wake = resolve; }); const event = q.items.shift()!; expect(validate?.(event)).toBe(true); yield event; if (event.type !== "progress") return; } })();
    }, cancelCapability(requestId, capabilityId, operation) { registry.handle({ kind: "capability.cancel", requestId, capabilityId, operation }); },
  });
  let sequence = 0;
  const service = new CompanyResearchService(repos, { resolveActiveLlm: async () => llm, resolveActiveSearch: async () => search }, client, { requestIdFactory: () => `request_${++sequence}`, now: () => new Date("2026-10-09T00:00:00Z") });
  try {
    const run = await service.start(item.id, company.id, { moduleIds: ["products_and_positioning" as const, "technology_and_metrics" as const, "development_and_readiness" as const, "competitive_position" as const], asOfDate: "2026-10-09" }); await service.whenSettled();
    expect(service.getRun(item.id, company.id, run.id)).toMatchObject({ status: "structure_failed", evidencePolicy: "required_v1" });
    const frozen = repos.companyResearchEvidence.getFrozen(run.id, run.attemptId!)!;
    expect(frozen).toBeDefined();
    const ordinary = frozen.events.find(e => e.phase === "ordinary" && e.responseState === "pending" && e.projections.length)!;
    const projection = ordinary.projections[0]!;
    const sent = requests.find(body => body.messages.some((m: any) => m.role === "tool")).messages.find((m: any) => m.role === "tool").content;
    expect(projection.savedText).toBe(sent.slice(0, projection.savedText.length));
    expect(projection.visibleHash).toBe(evidenceHash(sent)); expect(projection.visibleBytes).toBe(evidenceBytes(sent));
    if (dateProvider === "doubao" || dateProvider === "tavily") {
      expect(projection.sources[0]?.sourceDate).toMatchObject({ provider: dateProvider, fieldName: dateProvider === "doubao" ? "PublishTime" : "published_date", rawValue: rawDate, normalizedValue: "2026-08-22", status: "valid", nature: "published" });
      expect(sent).toContain('"date":"2026-08-22"');
      expect(sent).not.toContain(rawDate); // Metadata retention is distinct from actual model text.
      expect(JSON.stringify(db.prepare("SELECT event_json FROM company_research_evidence_events WHERE run_id = ?").all(run.id))).toContain(rawDate);
    }
    expect(projection.savedBytes).toBeLessThanOrEqual(12288); expect(projection.savedText).toBe(sent.slice(0, projection.savedText.length)); expect(projection.savedHash).toBe(evidenceHash(projection.savedText));
    const packet = repos.companyResearchEvidence.getPacket(run.id, run.attemptId!)!;
    if (dateProvider === "redirect") {
      const identity = { url: "https://c.test/canonical", requestedUrl: "https://a.test/source", finalUrl: "https://b.test/final", kind: "page_excerpt" };
      const page = frozen.events.flatMap(event => event.projections).find(p => p.toolName === "read_webpage")!;
      expect(page.sources[0]).toMatchObject(identity);
      const view = service.getEvidence(item.id, company.id, run.id);
      expect(Value.Check(ResearchEvidenceViewSchema, view)).toBe(true);
      expect(view.status).toBe("partial");
      if (view.status === "partial") expect(view.groups.flatMap(group => group.projections).find(p => p.toolName === "read_webpage")!.sources[0]).toMatchObject(identity);
      const pageRecord = packet.body.split("\n").map(line => JSON.parse(line)).find(record => record.sources.some((source: any) => source.kind === "page_excerpt"));
      expect(pageRecord.sources[0]).toMatchObject(identity);
      expect(pageRecord.text).toContain("实际重定向网页正文");
      expect(raw).toContain("https://a.test/source"); expect(raw).not.toContain("https://c.test/canonical");
      const candidate = JSON.parse(valid);
      candidate.coreSummary = ["原报告已有结论"];
      candidate.sections[0] = { sectionId: template.sections[0]!.sectionId, status: "found", summary: "已有事实", facts: [{ text: "已有事实", timeContext: null, claimType: "reported_fact", source: { title: "甲来源", url: "https://a.test/source" } }] };
      expect(() => validateStructuredResearch(JSON.stringify(candidate), raw, template)).not.toThrow();
      for (const url of [identity.finalUrl, identity.url]) {
        candidate.sections[0].facts[0].source.url = url;
        expect(() => validateStructuredResearch(JSON.stringify(candidate), raw, template)).toThrow(expect.objectContaining({ category: "source_mismatch" }));
      }
    }
    expect(JSON.parse(packet.body.split("\n")[0]!).text).toBe([...projection.savedText].slice(0, 2000).join(""));
    expect(frozen.events.flatMap(e => e.projections).some(p => p.sources.some(s => s.kind === "page_excerpt"))).toBe(true);
    expect(packet.snapshotHash).toBe(frozen.manifest.snapshotHash); expect(packet.hash).toBe(evidenceHash(packet.body));
    llm = { ...llm, contextWindow: 16000 };
    await service.retryStructuring(item.id, company.id, run.id); await service.whenSettled();
    expect(structureRequests).toHaveLength(2);
    expect(repos.companyResearchEvidence.getPacket(run.id, run.attemptId!)?.body).toBe(packet.body);
    llm = { ...llm, contextWindow: 128000 };
    await service.retryStructuring(item.id, company.id, run.id); await service.whenSettled();
    expect(service.getRun(item.id, company.id, run.id)).toMatchObject({ status: "completed", attemptId: run.attemptId });
    expect(structureRequests).toHaveLength(3); expect(searchCalls).toBe(1); expect(fetchCalls).toBe(1);
    for (const body of structureRequests) {
      const input = body.messages.find((m: any) => m.role === "user").content;
      expect(input.split("<frozen_evidence_packet>\n")[1].split("\n</frozen_evidence_packet>")[0]).toBe(packet.body);
      expect(body.max_tokens ?? body.max_completion_tokens).toBe(8192);
    }
    expect(repos.companyResearchDiagnostics.listByRunId(run.id).filter(d => d.phase === "structuring").every(d => d.packetHash === packet.hash && d.budgetVersion === "utf8-proxy-v1")).toBe(true);
  } finally { await registry.dispose(); db.close(); }
});
