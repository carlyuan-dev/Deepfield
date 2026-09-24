import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createCapabilityHostServices, type ActionCall, type CapabilityRegistrar } from "@deepfield/capability-sdk";
import { openTestDb } from "../../../../../packages/application/src/testing/application-test-helpers.js";
import { compileActionCatalog } from "../../../../../scripts/capabilities/build-actions.js";
import { createActionDefinitions } from "../../../../../capabilities/company-research/actions/definitions.js";
import { createBusinessActions } from "../../../../../capabilities/company-research/actions/business-actions.js";
import { companyForms, createCompanyFormProvider } from "../../../../../capabilities/company-research/actions/form-bindings.js";
import { ResearchDrafts } from "../../../../../capabilities/company-research/actions/drafts.js";
import { IndustryResearchService } from "../../../../../capabilities/company-research/application/industry-research-service.js";
import { FakeCompanyRecognizer } from "../../../../../capabilities/company-research/application/fake-company-recognizer.js";
import type { CompanyResearchOperationServices } from "../../../../../capabilities/company-research/main.js";
import type { CompanyResearchService } from "../../../../../capabilities/company-research/application/company-research-service.js";
import { prepareCapabilities, createCapabilityRuntime } from "../capabilities/runtime.js";
import { CapabilityRegistry } from "../capabilities/registry.js";
import { ChatInteractionHost } from "./interaction-host.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const db = openTestDb(); cleanup.push(db.cleanup);
  const industry = new IndustryResearchService(db.repos, new FakeCompanyRecognizer());
  const drafts = new ResearchDrafts(db.repos.companyResearchProtocol, {} as CompanyResearchService);
  const forms = createCompanyFormProvider(drafts);
  const business = createBusinessActions({ industryResearch: industry } as CompanyResearchOperationServices, forms.retainRecognition);
  const definitions = createActionDefinitions(async (id, input) => { const result = await business.handle(id, input); if (!result) throw new Error("Unsupported action"); return result; }, business.present, business.operation)
    .filter(action => ["topics.create", "companies.add", "companies.recognize", "companies.remove", "topics.delete"].includes(action.id));
  const root = await mkdtemp(join(tmpdir(), "deepfield-company-scope-"));
  const paths = { scanRoot: join(root, "installed"), bundledRoot: join(root, "bundled"), statePath: join(root, "state.json") };
  const packageRoot = join(paths.bundledRoot, "company-research"); await mkdir(packageRoot, { recursive: true });
  await cp(resolve("capabilities/company-research/docs"), join(packageRoot, "docs"), { recursive: true });
  await writeFile(join(packageRoot, "main.js"), "export function bootstrap() {}\n");
  const declarations = await compileActionCatalog({ capabilityRoot: packageRoot, actions: definitions });
  await writeFile(join(packageRoot, "capability.json"), JSON.stringify({ id: "company-research", name: "公司调研", description: "Fixture", version: "1.0.0", protocolVersion: 2, hostApiVersion: 2, entries: { main: "main.js" }, requirements: [], actions: declarations }));
  const registry = new CapabilityRegistry();
  const runtime = createCapabilityRuntime(await prepareCapabilities(paths), registry, async () => ({ bootstrap(registrar: CapabilityRegistrar) {
    for (const definition of definitions) registrar.registerAction!({ definition, declaration: declarations.find(entry => entry.id === definition.id)! });
    registrar.registerFormProvider!(companyForms.flatMap(form => {
      const actionIds = form.actionIds.filter(id => definitions.some(action => action.id === id));
      return actionIds.length ? [{ ...form, actionIds }] : [];
    }), forms);
  } }), db.repos.capabilityInvocations);
  cleanup.push(() => runtime.dispose());
  await runtime.start({ activateCapability: async () => {}, deactivateCapability: async () => {}, subscribeUnavailable: () => () => {} }, createCapabilityHostServices({}));
  expect(runtime.actionCatalog.find("company-research", "topics.create"), JSON.stringify(runtime.list())).toBeDefined();
  const conversation = db.repos.conversations.create();
  const host = new ChatInteractionHost(db.repos, registry, () => runtime, () => {}); host.begin("initial", conversation.id);
  const call = (actionId: string, input: unknown): ActionCall => ({ capabilityId: "company-research", actionId, contractDigest: declarations.find(entry => entry.id === actionId)!.contractDigest, input });
  const approve = async (scope: unknown) => {
    const item = await host.call("initial", "scope", "proposal.create", scope) as { id: string; revision: number; payload: { summary: string } };
    const user = db.repos.messages.append(conversation.id, "user", "确认无误", "approval");
    const result = await host.respond(conversation.id, { interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision", decision: "approve" } }, "user_message", user.id);
    return { item, result };
  };
  return { db, industry, host, conversation, call, approve };
}

it("creates the exact new company topic then imports discovered companies into only that successful receipt target", async () => {
  const f = await fixture(); const create = f.call("topics.create", { industry: "仓储机器人", researchScope: "国内" });
  const { item, result } = await f.approve({ firstCall: create, endCondition: "建好主题并导入找到的公司", rules: [
    { id: "create", call: create, maxExecutions: 1 },
    { id: "add", call: f.call("companies.add", {}), dynamicFields: ["companies"], bindings: { itemId: { ruleId: "create", path: "data.item.id" } }, maxExecutions: 2 },
  ] });
  expect(item.payload.summary).toContain("仓储机器人"); expect(item.payload.summary).toContain("最多 100 家"); expect(item.payload.summary).toContain("模型和搜索");
  expect(result.status).toBe("succeeded"); const topic = f.industry.listItems()[0]!;
  f.host.begin("resume", f.conversation.id);
  const added = await f.host.requestApproval({ conversationId: f.conversation.id, requestId: "resume", toolCallId: "add" }, f.call("companies.add", { itemId: topic.id, companies: [{ name: "发现的公司" }] }));
  expect(added.status).toBe("succeeded"); expect(f.industry.listCompanies(topic.id).map(item => item.name)).toEqual(["发现的公司"]);
  const other = f.industry.createItem({ industry: "其他主题" });
  const outside = await f.host.requestApproval({ conversationId: f.conversation.id, requestId: "resume", toolCallId: "outside" }, f.call("companies.add", { itemId: other.id, companies: [{ name: "不应导入" }] }));
  expect(outside.status).toBe("waiting"); expect(f.industry.listCompanies(other.id)).toEqual([]);
});

it("reuses recognition form continuation to import once under the confirmed scope", async () => {
  const f = await fixture(); const topic = f.industry.createItem({ industry: "识别主题" });
  const recognize = f.call("companies.recognize", { itemId: topic.id, text: "公司文本" });
  const { result } = await f.approve({ firstCall: recognize, endCondition: "识别并导入候选公司", rules: [
    { id: "recognize", call: recognize, maxExecutions: 1 },
    { id: "add", call: f.call("companies.add", { itemId: topic.id }), dynamicFields: ["companies"], maxExecutions: 1 },
  ] });
  expect(result.status).toBe("succeeded"); expect(f.host.coordinator.active(f.conversation.id)).toBeUndefined();
  expect(f.industry.listCompanies(topic.id).map(item => item.name)).toEqual(["Deepfield 演示公司"]);
  expect(f.host.list(f.conversation.id).map(item => item.status)).toEqual(["succeeded", "succeeded"]);
  expect(f.host.resultFor(result)).toMatchObject({ continuationReceipts: [{ status: "completed", actionId: "companies.add" }] });
});

it("executes an explicitly confirmed exact removal then exact topic deletion", async () => {
  const f = await fixture(); const topic = f.industry.createItem({ industry: "将删除主题" });
  const company = f.industry.addCompanies(topic.id, [{ name: "将移除公司" }])[0]!;
  const remove = f.call("companies.remove", { itemId: topic.id, companyIds: [company.id] });
  const deletion = f.call("topics.delete", { itemIds: [topic.id] });
  const { item, result } = await f.approve({ firstCall: remove, endCondition: "移除指定公司后删除指定主题", rules: [
    { id: "remove", call: remove, maxExecutions: 1 }, { id: "delete", call: deletion, maxExecutions: 1 },
  ] });
  expect(item.payload.summary).toContain("将移除公司"); expect(item.payload.summary).toContain("将删除主题"); expect(item.payload.summary).toContain("破坏性操作");
  expect(result.status).toBe("succeeded"); f.host.begin("resume", f.conversation.id);
  const last = await f.host.requestApproval({ conversationId: f.conversation.id, requestId: "resume", toolCallId: "delete" }, deletion);
  expect(last.status).toBe("succeeded"); expect(f.industry.listItems()).toEqual([]);
});
