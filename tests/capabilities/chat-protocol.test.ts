import { mkdtemp, readdir, rm, writeFile, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCapabilityHostServices } from "@deepfield/capability-sdk";
import { createCapabilityInvocationRepository, createRepositories, migrate } from "@deepfield/persistence";
import { CapabilityRegistry } from "../../apps/desktop/src/main/capabilities/registry.js";
import { createCapabilityRuntime, prepareCapabilities } from "../../apps/desktop/src/main/capabilities/runtime.js";
import { writeCapabilityPreferences } from "../../apps/desktop/src/main/capabilities/preferences.js";
import { CapabilityChatHost } from "../../apps/desktop/src/main/capabilities/chat-host.js";
import { createSnapshotWorkerLoader } from "../../apps/desktop/src/shared/capability-entry.js";
import { WorkerCapabilityRegistry } from "../../apps/desktop/src/worker/capabilities/registry.js";
import { AgentWorkerClient } from "../../apps/desktop/src/main/agent-worker-client.js";
import { FakeEndpoint } from "../../apps/desktop/src/main/agent-worker-client-test-helpers.js";
import { ProfileStore } from "../../apps/desktop/src/main/profile-store.js";
import { FakeWorker, chatEvent, makeSecrets } from "../../packages/application/src/chat/chat-service-helpers.js";
import { createApplicationRuntime } from "../../apps/desktop/src/main/application-runtime.js";
import { createPiCapabilityTools } from "../../apps/desktop/src/worker/tools/pi-capability-tools.js";
import { buildPackage as buildCompanyPackage } from "../../capabilities/company-research/build.js";
import { buildPackage } from "../../examples/capabilities/record-lookup/build.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("independent record lookup capability", () => {
  it("builds an isolated v2 package and serves records.find through the real main loader and gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepfield-record-lookup-"));
    roots.push(root);
    const paths = { scanRoot: join(root, "installed"), bundledRoot: join(root, "empty-bundled"), statePath: join(root, "state.json") };
    const packageRoot = join(paths.scanRoot, "record-lookup");
    await buildPackage(packageRoot);
    expect(await readdir(paths.scanRoot)).toEqual(["record-lookup"]);
    await writeCapabilityPreferences(paths.statePath, { schemaVersion: 1, initialized: true, enabledIds: ["record-lookup"] });

    const prepared = await prepareCapabilities(paths);
    expect(prepared.issues).toEqual([]);
    expect(prepared.selected.map(entry => entry.manifest.id)).toEqual(["record-lookup"]);
    const database = new DatabaseSync(":memory:");
    migrate(database);
    const runtime = createCapabilityRuntime(prepared, new CapabilityRegistry(), undefined, createCapabilityInvocationRepository(database));
    try {
      await runtime.start({ activateCapability: async () => { throw new Error("unexpected worker activation"); }, deactivateCapability: async () => {}, subscribeUnavailable: () => () => {} }, createCapabilityHostServices({}));
      expect(runtime.list()).toMatchObject([{ id: "record-lookup", status: "ready" }]);
      expect(runtime.workerSnapshot).toMatchObject([{ id: "record-lookup" }]);
      expect(runtime.workerSnapshot[0]).not.toHaveProperty("worker");
      const [entry] = runtime.actionCatalog.list();
      expect(entry?.actionId).toBe("records.find");
      const call = { capabilityId: "record-lookup", actionId: "records.find", contractDigest: entry!.declaration.contractDigest, input: { query: "交付", limit: 1 } };
      const caller = { callerId: "trusted-chat", source: "chat" as const, sessionId: "session-1", permissions: [] };
      const description = await runtime.actionGateway.describe(call, { ...caller, invocationId: "describe-1" });
      expect(description).toMatchObject({ status: "described", declaration: { id: "records.find" } });
      const result = await runtime.actionGateway.invoke(call, runtime.actionGateway.issue(call, caller));
      expect(result.status).toBe("completed");
      if (result.status !== "completed") throw new Error("record lookup did not complete");
      expect(result.data).toEqual({ items: [{ id: "sample-1", text: "交付时间待客户确认" }], truncated: false });
    } finally {
      await runtime.dispose();
      database.close();
    }

    await rm(packageRoot, { recursive: true });
    const afterRemoval = await prepareCapabilities(paths);
    expect(afterRemoval.catalog).toEqual({ entries: [], issues: [] });
    expect(afterRemoval.selected).toEqual([]);
    const emptyDatabase = new DatabaseSync(":memory:");
    migrate(emptyDatabase);
    const emptyRepositories = createRepositories(emptyDatabase);
    const emptyRegistry = new CapabilityRegistry();
    const emptyRuntime = createCapabilityRuntime(afterRemoval, emptyRegistry, undefined, emptyRepositories.capabilityInvocations);
    const emptyHost = new CapabilityChatHost(() => emptyRuntime, emptyRegistry, emptyRepositories);
    const fakeChatWorker = new FakeWorker({ events: request => [chatEvent(request.requestId, "completed", "offline chat reply")] });
    const profiles = makeSecrets("offline-unused-key");
    const application = createApplicationRuntime({ repositories: emptyRepositories, profiles, worker: fakeChatWorker,
      capabilityDirectory: () => emptyHost.directory() });
    try {
      await emptyRuntime.start({ activateCapability: async () => { throw new Error("unexpected worker activation"); }, deactivateCapability: async () => {}, subscribeUnavailable: () => () => {} }, createCapabilityHostServices({}));
      expect(emptyHost.directory()).toEqual([]);
      const conversation = application.conversationService.create();
      await application.chatService.send(conversation.id, "hello", "offline-chat", () => {});
      await vi.waitFor(() => expect(application.chatService.listMessages(conversation.id).some(message => message.content === "offline chat reply")).toBe(true));
      expect(fakeChatWorker.requests).toHaveLength(1);
      expect(fakeChatWorker.requests[0]?.context.capabilityDirectory).toBeUndefined();
      expect(createPiCapabilityTools(fakeChatWorker.requests[0]!, { request: async () => { throw new Error("unexpected capability call"); } })).toEqual([]);
      expect(fakeChatWorker.requests[0]?.toolAccess).toMatchObject({ network: "disabled", maxAgentTurns: 6 });
      expect(profiles.searchCalls).toBe(0);
    } finally {
      application.chatService.dispose();
      emptyHost.dispose();
      await emptyRuntime.dispose();
      emptyDatabase.close();
    }
  }, 60_000);
});

describe("offline company research Chat protocol", () => {
  it("confirms a prepared draft before queueing and reads the completed report through the public artifact route", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepfield-chat-company-"));
    roots.push(root);
    const paths = { scanRoot: join(root, "installed"), bundledRoot: join(root, "bundled"), statePath: join(root, "state.json") };
    await buildCompanyPackage(join(paths.bundledRoot, "company-research"));
    const database = new DatabaseSync(":memory:");
    migrate(database);
    const repositories = createRepositories(database);
    const profiles = makeSecrets("offline-unused-key");
    const settings = new ProfileStore(join(root, "settings.json"), { has: () => false, get: () => undefined, set() {}, delete() {} });
    await settings.initialize();
    const prepared = await prepareCapabilities(paths);
    const endpoint = new FakeEndpoint();
    const useContext = <T>(_context: unknown, work: () => T) => work();
    const workerServices = createCapabilityHostServices({ "model.execution": { mode: "fake", runtime: {} }, "usage.context": useContext });
    const worker = new WorkerCapabilityRegistry(value => endpoint.emit(value), createSnapshotWorkerLoader(prepared.workerSnapshot, workerServices));
    endpoint.postMessage = value => { worker.handle(value); };
    const client = new AgentWorkerClient(endpoint);
    const registry = new CapabilityRegistry();
    const services = createCapabilityHostServices({
      "company-research.repositories": { repositories, recordProfileDiagnostic() {} },
      "model.configuration": { profiles, settings: { get: () => settings.getView() }, onConfigurationChanged: () => () => {} },
      "model.execution": { mode: "fake", gateway: {}, transport: client },
      "tools.retrieval": {}, "usage.context": useContext,
      "document.save": { writeFile, rename, unlink, randomToken: randomUUID, showSaveDialog: async () => ({ canceled: true }) },
    });
    const runtime = createCapabilityRuntime(prepared, registry, undefined, repositories.capabilityInvocations);
    let host: CapabilityChatHost | undefined;
    try {
      await runtime.start(client, services);
      expect(runtime.list()).toMatchObject([{ id: "company-research", status: "ready" }]);
      const item = await registry.call({ capabilityId: "company-research", operation: "industryResearch.createItem", input: [{ industry: "离线验收主题" }], requestId: randomUUID() }) as { id: string };
      const company = repositories.companies.upsert({ name: "离线验收公司" });
      repositories.itemCompanies.add(item.id as never, company.id);
      repositories.companies.setProfileStatus(company.id, "ready");
      const conversationId = repositories.conversations.create().id;
      host = new CapabilityChatHost(() => runtime, registry, repositories);
      host.begin("chat-1", conversationId, "请调研这家公司，完成后分析报告");
      host.setActiveConversation(conversationId);
      await host.connectTaskProviders();
      const actionCall = (actionId: string, input: unknown) => ({ capabilityId: "company-research", actionId,
        contractDigest: runtime.actionCatalog.find("company-research", actionId)!.declaration.contractDigest, input });
      expect(await host.call("chat-1", "describe-create-topic", "describe", { capabilityId: "company-research", actionId: "topics.create" })).toMatchObject({ status: "described" });
      const createPending = await host.call("chat-1", "create-topic", "invoke", actionCall("topics.create", { industry: "机器人" })) as { status: string; confirmationRef: string };
      expect(createPending.status, JSON.stringify(createPending)).toBe("requires_confirmation");
      expect(repositories.capabilityItems.list().some(candidate => candidate.industry === "机器人")).toBe(false);
      const created = await host.approve(createPending.confirmationRef, conversationId, true) as { status: string; data: { summary: string } };
      expect(created).toMatchObject({ status: "completed", data: { summary: "已新建研究主题“机器人”。" } });
      expect(await host.call("chat-1", "describe-delete-topic", "describe", { capabilityId: "company-research", actionId: "topics.delete" })).toMatchObject({ status: "described" });
      const deletePending = await host.call("chat-1", "delete-topic", "invoke", actionCall("topics.delete", { itemIds: [item.id] })) as { status: string; confirmationRef: string };
      expect(deletePending.status).toBe("requires_confirmation");
      expect(host.dismiss(deletePending.confirmationRef, conversationId)).toBe(true);
      expect(repositories.capabilityItems.getById(item.id as never)).toBeDefined();
      expect(await host.call("chat-1", "describe-prepare", "describe", { capabilityId: "company-research", actionId: "research.prepare" })).toMatchObject({ status: "described" });
      const draft = await host.call("chat-1", "prepare", "invoke", actionCall("research.prepare", {
        itemId: item.id, companyId: company.id, direction: "product_and_technology", asOfDate: "2026-09-21",
      })) as { status: string; data: unknown };
      expect(draft.status).toBe("completed");
      expect(repositories.companyResearchRuns.listRuns(item.id as never, company.id)).toEqual([]);
      expect(await host.call("chat-1", "describe-submit", "describe", { capabilityId: "company-research", actionId: "research.submit" })).toMatchObject({ status: "described" });
      const pending = await host.call("chat-1", "submit", "invoke", actionCall("research.submit", draft.data)) as { status: string; confirmationRef: string };
      expect(pending.status).toBe("requires_confirmation");
      expect(repositories.companyResearchRuns.listRuns(item.id as never, company.id)).toEqual([]);
      const accepted = await host.approve(pending.confirmationRef, conversationId, true) as { status: string; taskRef: { capabilityId: string; taskId: string } };
      expect(accepted).toMatchObject({ status: "accepted", taskRef: { capabilityId: "company-research" } });
      expect(host.tasks(conversationId)).toHaveLength(1);
      await vi.waitFor(() => expect(repositories.companyResearchRuns.listRuns(item.id as never, company.id)[0]?.status).toBe("completed"), { timeout: 10_000 });
      const task = await host.call("chat-1", "task-get", "task.get", { taskRef: accepted.taskRef }) as {
        status: string; data: { status: string; artifactRefs: Array<{ capabilityId: string; artifactId: string; revision: string }> };
      };
      expect(task).toMatchObject({ status: "completed", data: { status: "succeeded", artifactRefs: expect.any(Array) } });
      const report = await host.call("chat-1", "report-read", "read", { artifactRef: task.data.artifactRefs[0], section: "raw" });
      expect(report).toMatchObject({ status: "completed", data: { format: "text", data: expect.stringContaining("离线测试") } });
      const runId = repositories.companyResearchRuns.listRuns(item.id as never, company.id)[0]!.id;
      expect(await host.call("chat-1", "describe-export-word", "describe", { capabilityId: "company-research", actionId: "reports.exportWord" })).toMatchObject({ status: "described" });
      const exportPending = await host.call("chat-1", "export-word", "invoke", actionCall("reports.exportWord", { itemId: item.id, companyId: company.id, runId, selection: { raw: true, structured: false } })) as { status: string; confirmationRef: string };
      expect(exportPending.status).toBe("requires_confirmation");
      const exported = await host.approve(exportPending.confirmationRef, conversationId, true);
      expect(exported).toMatchObject({ status: "completed", data: { status: "cancelled", summary: expect.stringContaining("已取消") } });
    } finally {
      host?.dispose();
      await runtime.dispose();
      await worker.dispose();
      client.dispose();
      database.close();
    }
  }, 60_000);
});
