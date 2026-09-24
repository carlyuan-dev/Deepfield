import { describe, expect, it, vi } from "vitest";
import { companyForms, createCompanyFormProvider } from "./form-bindings.js";
import { ResearchDrafts, type ProtocolStore } from "./drafts.js";
import type { CompanyResearchService } from "../application/company-research-service.js";

export function formFixture() {
  const rows = new Map<string, string>();
  const store = { getDraft: (id: string) => rows.get(id), saveDraft: (id: string, value: string) => rows.set(id, value), deleteDraft: (id: string) => rows.delete(id) } as unknown as ProtocolStore;
  const drafts = new ResearchDrafts(store, { validateBatchEntry: vi.fn() } as unknown as CompanyResearchService);
  return { rows, drafts, provider: createCompanyFormProvider(drafts) };
}
const parameters = { itemId: "topic", companyId: "company", direction: "product_and_technology", asOfDate: "2026-09-01" } as const;
describe("company forms", () => {
  it("declares the correct parent for new topics, topic operations, and company operations", async () => {
    const f = formFixture();
    expect((await f.provider.prepare("topic", "topics.create", { industry: "机器人" })).parentView).toEqual({ capabilityId: "company-research", viewId: "topics", input: {} });
    expect((await f.provider.prepare("companies-add", "companies.add", { itemId: "topic", companies: [] })).parentView).toEqual({ capabilityId: "company-research", viewId: "companies", input: { itemId: "topic" } });
    expect((await f.provider.prepare("company-profile", "companies.update", { itemId: "topic", companyId: "company" })).parentView).toEqual({ capabilityId: "company-research", viewId: "company", input: { itemId: "topic", companyId: "company" } });
    expect((await f.provider.prepare("research", "research.submit", f.drafts.prepare(parameters))).parentView).toEqual({ capabilityId: "company-research", viewId: "company", input: { itemId: "topic", companyId: "company" } });
  });
  it.each(companyForms)("registers $id with its existing component and action", async definition => {
    const f = formFixture();
    const values = definition.id === "research" ? f.drafts.prepare(parameters) : {};
    const snapshot = await f.provider.prepare(definition.id, definition.actionIds[0], values);
    expect(definition.component).toBeTruthy();
    expect((await f.provider.read(snapshot.draft)).view.viewId).toBe("form");
    expect(snapshot.inputSchema).toBeTruthy();
    await f.provider.release(snapshot.draft);
    await expect(f.provider.read(snapshot.draft)).rejects.toThrow();
  });
  it("merges user and model fields and rejects stale revision", async () => {
    const { provider } = formFixture();
    const initial = await provider.prepare("topic", "topics.create", { industry: "模型主题", notes: "初稿" });
    const human = await provider.update(initial.draft, { industry: "用户修改的主题" });
    await expect(provider.update(initial.draft, { notes: "旧版本" })).rejects.toMatchObject({ code: "revision_changed" });
    const model = await provider.update(human.draft, { notes: "模型深化后的备注" });
    expect((await provider.submission(model.draft)).input).toEqual({ industry: "用户修改的主题", notes: "模型深化后的备注" });
  });
  it("requires final batch step before admission and preserves per-company input", async () => {
    const { provider } = formFixture();
    let snapshot = await provider.prepare("research-batch", "research.submitBatch", { itemId: "topic", entries: [{ companyId: "a", input: { direction: parameters.direction, asOfDate: parameters.asOfDate } }] });
    await expect(provider.submission(snapshot.draft)).rejects.toThrow("invalid_form");
    snapshot = await provider.transition(snapshot.draft, "common");
    snapshot = await provider.update(snapshot.draft, { entries: [{ companyId: "a", input: { direction: parameters.direction, asOfDate: parameters.asOfDate, focusScope: "用户最新条件" } }] });
    snapshot = await provider.transition(snapshot.draft, "confirm");
    expect((await provider.submission(snapshot.draft)).input).toMatchObject({ entries: [{ input: { focusScope: "用户最新条件" } }] });
  });
  it("keeps research parameters only in ResearchDrafts and updates that draft", async () => {
    const f = formFixture(); const prepared = f.drafts.prepare(parameters);
    let snapshot = await f.provider.prepare("research", "research.submit", prepared);
    expect(JSON.parse(f.rows.get(snapshot.draft.draftId)!).values).toEqual({ draftRef: prepared.draftRef });
    snapshot = await f.provider.update(snapshot.draft, { parameters: { focusScope: "新条件" } });
    expect((await f.provider.submission(snapshot.draft)).input).toMatchObject({ parameters: { focusScope: "新条件" } });
    await f.provider.release(snapshot.draft); expect(f.rows.size).toBe(0);
  });
  it("recognition receipt moves the same draft to separately approved selection", async () => {
    const { provider } = formFixture(); const first = await provider.prepare("companies-import", "companies.recognize", { itemId: "topic", text: "公司甲" });
    await provider.submission(first.draft);
    const next = await provider.afterAction!(first.draft, "companies.recognize", { status: "completed", data: { items: [{ name: "公司甲" }] } });
    expect(next?.nextActionId).toBe("companies.add"); expect(next?.snapshot.draft.draftId).toBe(first.draft.draftId);
    expect((await provider.submission(next!.snapshot.draft)).input).toEqual({ itemId: "topic", companies: [{ name: "公司甲" }] });
  });
  it("requires at least one Word export selection", async () => {
    const { provider } = formFixture(); const form = await provider.prepare("report-export", "reports.exportWord", { itemId: "t", companyId: "c", runId: "r", selection: { raw: false, structured: false } });
    const updated = await provider.update(form.draft, { selection: { raw: true } });
    expect((await provider.submission(updated.draft)).input).toMatchObject({ selection: { raw: true, structured: false } });
  });
});
