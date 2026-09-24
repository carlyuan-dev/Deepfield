import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, rm, writeFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createCapabilityHostServices } from "@deepfield/capability-sdk";
import { createUsageQueryService } from "@deepfield/base/usage";
import { createUsageRepository } from "../../packages/persistence/src/usage-repository.js";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import { appResult } from "@deepfield/contracts";
import { prepareCapabilities, createCapabilityRuntime } from "../../apps/desktop/src/main/capabilities/runtime.js";
import { CapabilityRegistry } from "../../apps/desktop/src/main/capabilities/registry.js";
import { createSnapshotWorkerLoader, loadCapabilityEntry } from "../../apps/desktop/src/shared/capability-entry.js";
import { WorkerCapabilityRegistry } from "../../apps/desktop/src/worker/capabilities/registry.js";
import { AgentWorkerClient } from "../../apps/desktop/src/main/agent-worker-client.js";
import { FakeEndpoint } from "../../apps/desktop/src/main/agent-worker-client-test-helpers.js";
import { writeEnabledIds } from "../../apps/desktop/src/main/capabilities/preferences.js";
import { createApplicationRuntime } from "../../apps/desktop/src/main/application-runtime.js";
import { ProfileStore } from "../../apps/desktop/src/main/profile-store.js";
import { FakeWorker, chatEvent, makeSecrets } from "../../packages/application/src/chat/chat-service-helpers.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it("installs portable artifacts, runs two stages and Word export, and preserves reports across disabled/removed/re-enabled startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepfield-artifact-")); roots.push(root);
  const bundle = join(root, "bundled/company-research");
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    import {buildPackage} from ${JSON.stringify(pathToFileURL(resolve("capabilities/company-research/build.ts")).href)};
    await buildPackage(${JSON.stringify(bundle)});
  `], { maxBuffer: 4 * 1024 * 1024 });
  // Native Node import from a temp directory with no adjacent node_modules.
  const nativeImport = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
    for (const entry of ['main','worker']) {
      const module = await import(new URL('./dist/'+entry+'.js', ${JSON.stringify(pathToFileURL(bundle + "/").href)}));
      if (typeof module.bootstrap !== 'function') throw new Error('missing bootstrap');
    }
  `], { cwd: root });
  expect(nativeImport.stdout + nativeImport.stderr).not.toMatch(/Cannot load|Cannot find module|Cannot polyfill/);
  const paths = { bundledRoot: join(root, "bundled"), scanRoot: join(root, "userData/capabilities"), statePath: join(root, "userData/capabilities-state.json") };
  let database = openDatabase(join(root, "deepfield.sqlite")); migrate(database);
  let repositories = createRepositories(database);
  const profiles = makeSecrets("offline-unused-key");
  const settings = new ProfileStore(join(root, "settings.json"), { has: () => false, get: () => undefined, set() {}, delete() {} });
  await settings.initialize();
  const usage = () => createUsageQueryService(createUsageRepository(database));
  const useContext = <T>(_context: unknown, work: () => T) => work();
  const probe = { moduleEvaluations: 0, businessInstances: 0 };
  const load: typeof loadCapabilityEntry = async (...args) => {
    probe.moduleEvaluations++;
    const module = await loadCapabilityEntry(...args);
    return { bootstrap(registrar, services) { probe.businessInstances++; return module.bootstrap(registrar, services); } };
  };
  async function start() {
    const prepared = await prepareCapabilities(paths);
    const endpoint = new FakeEndpoint();
    const workerServices = createCapabilityHostServices({ "model.execution": { mode: "fake", runtime: {} }, "usage.context": useContext });
    const worker = new WorkerCapabilityRegistry(value => endpoint.emit(value), createSnapshotWorkerLoader(prepared.workerSnapshot, workerServices, load));
    endpoint.postMessage = value => { worker.handle(value); };
    const client = new AgentWorkerClient(endpoint);
    const registry = new CapabilityRegistry();
    const services = createCapabilityHostServices({
      "company-research.repositories": { repositories, recordProfileDiagnostic() {} },
      "model.configuration": { profiles, settings: { get: () => settings.getView() }, onConfigurationChanged: () => () => {} },
      "model.execution": { mode: "fake", gateway: {}, transport: client },
      "tools.retrieval": {}, "usage.context": useContext,
      "document.save": { writeFile, rename, unlink, randomToken: randomUUID, showSaveDialog: async () => ({ canceled: false, filePath: join(root, "report.docx") }) },
    });
    const runtime = createCapabilityRuntime(prepared, registry, load);
    await runtime.start(client, services);
    const call = (operation: string, input: unknown[]) => registry.call({ capabilityId: "company-research", operation, input, requestId: randomUUID() });
    return { runtime, registry, call, async dispose() { await runtime.dispose(); await worker.dispose(); client.dispose(); } };
  }
  async function assertCore() {
    const app = createApplicationRuntime({ repositories, profiles, worker: new FakeWorker({ events: request => [chatEvent(request.requestId, "completed", "offline chat reply")] }) });
    const conversation = app.conversationService.create();
    await app.chatService.send(conversation.id, "hello", randomUUID(), () => {});
    await vi.waitFor(() => expect(app.chatService.listMessages(conversation.id).some(message => message.content === "offline chat reply")).toBe(true));
    expect((await settings.getView()).llm.profiles).toEqual([]);
    expect((await usage().getSummary({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", timeZone: "UTC", serviceKind: "llm" })).requests).toBe(0);
  }
  let active: Awaited<ReturnType<typeof start>> | undefined;
  try {
    active = await start();
    expect(active.runtime.list()[0]?.status).toBe("ready");
    expect(await appResult(() => active!.call("industryResearch.getCompanyProfileProgress", ["missing-item"]))).toEqual({ ok: false, error: { code: "RESOURCE.NOT_FOUND", category: "resource" } });
    await assertCore();
    const item = await active.call("industryResearch.createItem", [{ industry: "离线验收主题" }]) as { id: string };
    const company = repositories.companies.upsert({ name: "离线验收公司" });
    repositories.itemCompanies.add(item.id as never, company.id);
    repositories.companies.setProfileStatus(company.id, "ready");
    const prepare = active.registry.publicAction("company-research", "research.prepare")!;
    const submit = active.registry.publicAction("company-research", "research.submit")!;
    expect(submit.requiresConfirmation).toBe(true);
    const prepared = await prepare.handler({ itemId: item.id, companyId: company.id, direction: "product_and_technology", asOfDate: "2026-09-21" }, { invocationId: "offline-prepare", source: "chat" });
    if (prepared.status !== "completed") throw new Error("draft not prepared");
    expect(repositories.companyResearchRuns.listRuns(item.id as never, company.id)).toEqual([]);
    const accepted = await submit.handler(prepared.data, { invocationId: "offline-submit", source: "chat" });
    expect(accepted.status).toBe("accepted");
    expect(await submit.handler(prepared.data, { invocationId: "offline-submit", source: "chat" })).toEqual(accepted);
    await vi.waitFor(() => expect(repositories.companyResearchRuns.listRuns(item.id as never, company.id)[0]?.status).toBe("completed"));
    const saved = repositories.companyResearchRuns.listRuns(item.id as never, company.id)[0]!;
    if (accepted.status !== "accepted") throw new Error("submission not accepted");
    expect(await active.registry.taskProvider("company-research")!.get(accepted.taskRef)).toMatchObject({ status: "succeeded", artifactRefs: expect.any(Array), finishedAt: expect.any(String) });
    const report = repositories.companyResearchRuns.getByIdForTarget(item.id as never, company.id, saved.id as never)!;
    expect(report).toMatchObject({ rawReportText: expect.stringContaining("离线测试"), structuredContent: expect.any(Object) });
    expect(await active.call("companyResearch.exportWord", [item.id, company.id, saved.id, { raw: true, structured: true }])).toMatchObject({ status: "saved" });
    expect((await readFile(join(root, "report.docx"))).subarray(0, 2).toString()).toBe("PK");
    await active.runtime.setEnabled("company-research", false);
    await active.dispose(); active = undefined;
    database.close(); database = openDatabase(join(root, "deepfield.sqlite")); migrate(database); repositories = createRepositories(database);
    for (const state of ["disabled", "removed-package", "removed-root"] as const) {
      if (state === "removed-package") await rm(join(paths.scanRoot, "company-research"), { recursive: true });
      if (state === "removed-root") await rm(paths.scanRoot, { recursive: true });
      probe.moduleEvaluations = 0; probe.businessInstances = 0;
      active = await start();
      expect(probe).toEqual({ moduleEvaluations: 0, businessInstances: 0 });
      expect(active.runtime.readyEntries()).toEqual([]);
      await assertCore();
      expect(repositories.companyResearchRuns.getByIdForTarget(item.id as never, company.id, saved.id as never)).toEqual(report);
      await active.dispose(); active = undefined;
    }
    // Explicit reinstall + enable; normal startup never silently restores removal.
    await cp(bundle, join(paths.scanRoot, "company-research"), { recursive: true });
    await writeEnabledIds(paths.statePath, ["company-research"]);
    active = await start();
    expect(active.runtime.list()[0]?.status).toBe("ready");
    expect(await active.call("companyResearch.getRun", [item.id, company.id, saved.id])).toEqual(report);
  } finally { await active?.dispose(); database.close(); }
}, 60_000);
