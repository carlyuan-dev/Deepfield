import { expect, it } from "vitest";
import { isCompiledActionDeclaration } from "@deepfield/capability-sdk";
import { createActionDefinitions } from "./definitions.js";
import { createBusinessActions } from "./business-actions.js";
import type { CompanyResearchOperationServices } from "../main.js";

it("publishes valid metadata for every company action", () => {
  const invalid = createActionDefinitions().filter(action => !isCompiledActionDeclaration({
    id: action.id, title: action.title, description: action.description, mode: action.mode,
    effects: action.effects, inputSchema: JSON.parse(JSON.stringify(action.inputSchema)), outputSchema: JSON.parse(JSON.stringify(action.outputSchema)),
    documentation: { ...action.documentation, digest: `sha256:${"0".repeat(64)}` }, permissions: action.permissions,
    requiresConfirmation: action.requiresConfirmation, contractDigest: `sha256:${"0".repeat(64)}`,
  })).map(action => action.id);
  expect(invalid, JSON.stringify(createActionDefinitions().filter(action => invalid.includes(action.id)).map(action => ({ id: action.id, input: action.inputSchema })), null, 2)).toEqual([]);
});

it("marks auto-enriching import and destructive deletion for confirmation", () => {
  const actions = new Map(createActionDefinitions().map(action => [action.id, action]));
  expect(actions.get("companies.add")).toMatchObject({ effects: { data: "write", consumesResources: true }, requiresConfirmation: true });
  expect(actions.get("companies.recognize")).toMatchObject({ effects: { data: "read", consumesResources: true }, requiresConfirmation: true });
  expect(actions.get("topics.delete")).toMatchObject({ effects: { data: "destructive", consumesResources: false }, requiresConfirmation: true });
  expect(actions.get("reports.exportWord")).toMatchObject({ requiresConfirmation: true, mode: "immediate" });
  expect(actions.get("companies.add")?.taskAuthorization).toMatchObject({ mode: "scope", dynamicFields: ["companies"], resourceFields: ["itemId"] });
  expect(actions.get("topics.delete")?.taskAuthorization).toMatchObject({ dynamicFields: [], resourceFields: [] });
});

it("declares a non-mutating topic parent and a real destination after creation", async () => {
  let created = 0;
  const services = { industryResearch: {
    createItem: (input: { industry: string }) => { created++; return { id: "topic", industry: input.industry }; },
  }, companyResearch: {}, companyResearchBatch: {}, companyResearchWordExport: {} } as unknown as CompanyResearchOperationServices;
  const business = createBusinessActions(services);
  const input = { industry: "机器人", researchScope: "仓储" };
  expect(business.operation("topics.create", input)).toMatchObject({ target: { viewId: "topics", input: {} }, autoOpen: true });
  expect(created).toBe(0);
  const outcome = await business.handle("topics.create", input) as { data: Record<string, unknown> };
  expect(created).toBe(1);
  expect(business.resultPresentation("topics.create", input, "已创建", outcome.data)).toMatchObject({ target: { viewId: "companies", input: { itemId: "topic" } }, autoOpen: true });
  expect(business.operation("topics.list", {})).toBeUndefined();
});

it("offers a prepared research draft without automatically opening the dirty editor", () => {
  const business = createBusinessActions({ industryResearch: {}, companyResearch: {}, companyResearchBatch: {}, companyResearchWordExport: {} } as unknown as CompanyResearchOperationServices);
  expect(business.resultPresentation("research.prepare", {}, "草稿已准备", { draftRef: { draftId: "draft-1", revision: "rev-1" } })).toEqual({
    text: "调研草稿已准备，可检查参数后提交。",
    linkLabel: "查看调研草稿",
    target: { capabilityId: "company-research", viewId: "research-draft", input: { draftId: "draft-1", revision: "rev-1" } },
  });
});

it("resolves target names, rejects missing delete targets, and reports native export cancellation", async () => {
  const deleted: string[][] = [];
  const services = { industryResearch: {
    getItem: (id: string) => id === "topic" ? { id, industry: "半导体" } : undefined,
    listCompanies: () => [{ id: "company", name: "甲公司" }],
    createItem: (input: { industry: string }) => ({ id: "new", industry: input.industry }),
    deleteItems: (ids: string[]) => { deleted.push(ids); },
  }, companyResearch: { getRun: () => ({ id: "run", schemaVersion: "company-research-report-v1", template: { title: "技术" }, createdAt: "2026-09-01T00:00:00Z" }) },
  companyResearchBatch: {}, companyResearchWordExport: { export: async () => ({ status: "cancelled" }) } } as unknown as CompanyResearchOperationServices;
  const business = createBusinessActions(services);
  expect(business.present("topics.delete", { itemIds: ["topic"] }).fields).toContainEqual({ label: "影响主题", value: "1. 半导体" });
  await expect(business.handle("topics.delete", { itemIds: ["missing"] })).rejects.toMatchObject({ code: "not_found" });
  expect(deleted).toEqual([]);
  expect(await business.handle("topics.create", { industry: "机器人" })).toMatchObject({ status: "completed", data: { summary: "已新建研究主题“机器人”。" } });
  const result = await business.handle("reports.exportWord", { itemId: "topic", companyId: "company", runId: "run", selection: { raw: true, structured: false } });
  expect(result).toMatchObject({ status: "completed", data: { status: "cancelled", summary: expect.stringContaining("已取消") } });
});

it("updates shared company fields as a versioned patch and shows explicit clears", async () => {
  const current: Record<string, unknown> = { id: "company", itemId: "topic", name: "甲公司", legalName: "甲公司有限责任公司", aliases: ["旧别名"], headquarters: "上海", stockListings: [] };
  let written: Record<string, unknown> | undefined;
  const services = { industryResearch: {
    getItem: () => ({ id: "topic", industry: "半导体" }),
    listCompanies: () => [current],
    updateCompany: (_id: string, profile: Record<string, unknown>) => { written = profile; return { id: "company", profileStatus: "ready", ...profile }; },
  }, companyResearch: {}, companyResearchBatch: {}, companyResearchWordExport: {} } as unknown as CompanyResearchOperationServices;
  const business = createBusinessActions(services);
  const details = await business.handle("companies.get", { itemId: "topic", companyId: "company" }) as unknown as { data: { item: { profileRevision: string } } };
  const input = { itemId: "topic", companyId: "company", expectedRevision: details.data.item.profileRevision, profile: { name: "新名称", aliases: [], legalName: null } };
  const displayed = business.present("companies.update", input);
  expect(displayed.fields).toContainEqual({ label: "别名", value: "无/清空" });
  expect(displayed.fields).toContainEqual({ label: "法定名称", value: "未填写" });
  await business.handle("companies.update", input);
  expect(written).toMatchObject({ name: "新名称", headquarters: "上海", aliases: [] });
  expect(written).not.toHaveProperty("legalName");
  current.headquarters = "北京";
  await expect(business.handle("companies.update", input)).rejects.toMatchObject({ code: "revision_changed" });
});
