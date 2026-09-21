import { afterEach, expect, it, vi } from "vitest";
import { openTestDb, type TestDb } from "../../../packages/application/src/testing/application-test-helpers.js";
import { activate, type CompanyResearchMainPorts } from "../main.js";
import { CapabilityRegistry, activateRegisteredCapability } from "../../../apps/desktop/src/main/capabilities/registry.js";
import { getCompanyResearchTemplate } from "../contracts/index.js";
import { CompanyResearchService } from "./company-research-service.js";
import { AgentWorkerClient } from "../../../apps/desktop/src/main/agent-worker-client.js";
import { FakeEndpoint } from "../../../apps/desktop/src/main/agent-worker-client-test-helpers.js";
import { createCompanyResearchWorkerClient } from "../worker-client.js";
const dbs: TestDb[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.cleanup(); });

it("interrupts registered business services before Worker exit rejects their live stream", async () => {
  const db = openTestDb(); dbs.push(db);
  const item = db.repos.capabilityItems.create({ industry: "test" });
  const companies = ["first", "next"].map(name => {
    const company = db.repos.companies.upsert({ name });
    db.repos.companies.setProfileStatus(company.id, "ready");
    db.repos.itemCompanies.add(item.id, company.id);
    return company;
  });
  const endpoint = new FakeEndpoint();
  const client = new AgentWorkerClient(endpoint);
  const send = vi.spyOn(client, "sendCapability");
  const cancel = vi.spyOn(client, "cancelCapability");
  const registry = new CapabilityRegistry();
  const ports: CompanyResearchMainPorts = {
    repositories: db.repos,
    profiles: {
      resolveActiveLlm: async () => ({ id: "l", name: "l", provider: "custom", protocol: "openai_compatible", baseUrl: "https://a.test", modelId: "m", contextWindow: 32000, apiKey: "s" }),
      resolveActiveSearch: async () => ({ id: "s", name: "s", provider: "zhipu", baseUrl: "https://a.test", options: {}, apiKey: "s" }),
    },
    worker: createCompanyResearchWorkerClient(client),
    companyRecognizer: { recognize: async () => [] }, companyCompleter: { prepare: vi.fn() }, requestIdFactory: () => crypto.randomUUID(),
    settings: { get: vi.fn() }, documentSave: { showSaveDialog: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), unlink: vi.fn(), randomToken: () => "token" },
  };
  const activation = await activateRegisteredCapability({ registry, capabilityId: "company-research",
    activateMain: registrar => activate(registrar, ports), activateWorker: async () => {},
    onWorkerUnavailable: listener => client.subscribeUnavailable(listener),
  });
  await registry.call({ capabilityId: "company-research", operation: "companyResearchBatch.start", requestId: "start",
    input: [item.id, companies.map(company => ({ companyId: company.id, input: { direction: "product_and_technology", asOfDate: "2026-09-01" } }))],
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  const batch = db.repos.companyResearchBatches.getActive()!;
  const run = db.repos.companyResearchRuns.getByIdForTarget(item.id, companies[0]!.id, db.repos.companyResearchRuns.getActive()!.id)!;
  expect(send).toHaveBeenCalledTimes(1);
  endpoint.emitExit(1);
  await activation.dispose();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(registry.readyIds()).toEqual([]);
  expect(db.repos.companyResearchBatches.getById(batch.batchId)).toEqual(batch);
  expect(db.repos.companyResearchRuns.getByIdForTarget(item.id, companies[0]!.id, run.id)).toEqual(run);
  expect(db.repos.companyResearchRuns.listRuns(item.id, companies[1]!.id)).toEqual([]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  client.dispose();
});

it("leaves actual active batch and raw report untouched until successful Worker readiness, then recovers once", async () => {
  const db = openTestDb(); dbs.push(db);
  const item = db.repos.capabilityItems.create({ industry: "test" });
  const company = db.repos.companies.upsert({ name: "company" }); db.repos.itemCompanies.add(item.id, company.id);
  const input = { direction: "product_and_technology", asOfDate: "2026-09-01" } as const;
  const run = db.repos.companyResearchRuns.createResearching(item.id, company.id, input,
    { ...input, currentDate: input.asOfDate, companyName: company.name, topicName: item.industry }, getCompanyResearchTemplate(input.direction));
  db.repos.companyResearchRuns.completeRaw(run.id, "preserved raw report");
  db.repos.companyResearchBatches.save({ batchId: "active", itemId: item.id, status: "running",
    entries: [{ companyId: company.id, input, status: "running", runId: run.id, stage: "structure" }], total: 1, processed: 0, succeeded: 0, failed: 0 });
  db.repos.companyResearchBatches.save({ batchId: "terminal", itemId: item.id, status: "completed", entries: [], total: 0, processed: 0, succeeded: 0, failed: 0 });
  const beforeBatch = db.repos.companyResearchBatches.getById("active");
  const beforeRun = db.repos.companyResearchRuns.getByIdForTarget(item.id, company.id, run.id);
  const deleted = vi.spyOn(db.repos.companyResearchBatches, "deleteAllTerminal");
  const saved = vi.spyOn(db.repos.companyResearchBatches, "save");
  const cleanup = vi.spyOn(CompanyResearchService.prototype, "cleanupAbandoned");
  const prepare = vi.fn(async () => { throw new Error("profiles must stay reserved"); });
  const ports: CompanyResearchMainPorts = {
    repositories: db.repos,
    profiles: { resolveActiveLlm: vi.fn(), resolveActiveSearch: vi.fn() },
    worker: { sendResearch: vi.fn(), cancelResearch: vi.fn() },
    companyRecognizer: { recognize: vi.fn() }, companyCompleter: { prepare }, requestIdFactory: () => "request",
    settings: { get: vi.fn() }, documentSave: { showSaveDialog: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), unlink: vi.fn(), randomToken: () => "token" },
  };
  const registry = new CapabilityRegistry();
  await expect(activateRegisteredCapability({ registry, capabilityId: "company-research",
    activateMain: registrar => activate(registrar, ports),
    activateWorker: async () => {
      expect(deleted).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
      throw new Error("worker failed");
    }, onWorkerUnavailable: () => () => {},
  })).rejects.toThrow("worker failed");
  expect(deleted).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  expect(db.repos.companyResearchBatches.getById("active")).toEqual(beforeBatch);
  expect(db.repos.companyResearchBatches.getById("terminal")).toBeDefined();
  expect(db.repos.companyResearchRuns.getByIdForTarget(item.id, company.id, run.id)).toEqual(beforeRun);
  const activation = await activateRegisteredCapability({ registry, capabilityId: "company-research",
    activateMain: registrar => activate(registrar, ports),
    activateWorker: async () => { expect(cleanup).not.toHaveBeenCalled(); }, onWorkerUnavailable: () => () => {},
  });
  await activation.ready();
  expect(cleanup).toHaveBeenCalledOnce(); expect(deleted).toHaveBeenCalledOnce(); expect(saved).toHaveBeenCalledOnce();
  expect(db.repos.companyResearchBatches.getById("active")).toMatchObject({ status: "paused", entries: [{ status: "running", interrupted: true }] });
  expect(db.repos.companyResearchRuns.getByIdForTarget(item.id, company.id, run.id)).toMatchObject({ status: "structure_failed", rawReportText: "preserved raw report" });
  await registry.dispose();
});
