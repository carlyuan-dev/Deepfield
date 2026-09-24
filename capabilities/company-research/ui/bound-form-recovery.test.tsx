// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { CapabilityInteractionEditor } from "@deepfield/capability-sdk";
import type { Company } from "../contracts/index.js";
import { StartCompanyResearchInputSchema } from "../contracts/index.js";
import type { CompanyResearchService } from "../application/company-research-service.js";
import type { CompanyResearchOperationServices } from "../main.js";
import { createCompanyFormProvider } from "../actions/form-bindings.js";
import { createBusinessActions } from "../actions/business-actions.js";
import { ResearchDrafts, type ProtocolStore } from "../actions/drafts.js";
import { makeFakeApi } from "../../../apps/desktop/src/renderer/renderer-test-helpers.js";
import { useInteractionForm, scopeControl } from "./form-control.js";
import { CompanyResearchModal } from "./CompanyResearchModal.js";
import { CompanyProfileForm } from "./CompanyProfileModal.js";
import { ImportCompaniesModal } from "./ImportCompaniesModal.js";
import { ResearchItemModal } from "./ResearchItemModal.js";

async function binding(formId: string, actionId: string, input: any) {
  const rows = new Map<string, string>();
  const drafts = new ResearchDrafts({ getDraft: (id: string) => rows.get(id), saveDraft: (id: string, value: string) => rows.set(id, value), deleteDraft: (id: string) => rows.delete(id) } as unknown as ProtocolStore,
    { validateBatchEntry: (_itemId: string, _companyId: string, value: unknown) => { if (!Value.Check(StartCompanyResearchInputSchema, value)) throw new Error("invalid_research_date"); } } as unknown as CompanyResearchService);
  const provider = createCompanyFormProvider(drafts);
  let snapshot = await provider.prepare(formId, actionId, actionId === "research.submit" ? drafts.prepare(input) : input);
  let revision = 1; let status = "waiting";
  const listeners = new Set<() => void>(); const submit = vi.fn(); const notify = () => listeners.forEach(listener => listener());
  const check = (expected: number) => { if (expected !== revision) throw new Error("revision_changed"); };
  const editor: CapabilityInteractionEditor = {
    read: async () => ({ revision, status, formId, actionId, snapshot }),
    beginEdit: vi.fn(async expected => { check(expected); if (status !== "waiting") throw new Error("not_waiting"); status = "editing"; revision++; notify(); }),
    update: async (expected, patch) => { check(expected); if (status !== "editing") throw new Error("not_editing"); snapshot = await provider.update(snapshot.draft, patch); status = "waiting"; revision++; notify(); return { revision }; },
    transition: async (expected, step) => { check(expected); snapshot = await provider.transition(snapshot.draft, step); revision++; notify(); return { revision }; },
    respond: async (expected, decision) => { check(expected); if (decision === "approve") submit((await provider.submission(snapshot.draft)).input); status = decision === "approve" ? "submitted" : "cancelled"; revision++; notify(); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { editor, submit, notify, modelPatch: async (patch: unknown) => { snapshot = await provider.update(snapshot.draft, patch); revision++; }, replaceLock: () => { revision++; notify(); } };
}

it("corrects a rejected date under its own lock and retains other unsent fields", async () => {
  const f = await binding("research", "research.submit", { itemId: "topic", companyId: "company", direction: "product_and_technology", asOfDate: "2026-09-01" });
  function Form() { const { control, error } = useInteractionForm(f.editor); return control ? <><CompanyResearchModal topicName="主题" companyName="公司" control={scopeControl(control, "parameters")!} onClose={() => {}} onStart={() => control.confirm()} />{error && <p role="alert">{error}</p>}</> : null; }
  render(<Form />);
  fireEvent.change(await screen.findByLabelText("截至日期"), { target: { value: "" } });
  await screen.findByText("invalid_research_date");
  expect((await f.editor.read()).status).toBe("editing");
  fireEvent.change(screen.getByLabelText("关注范围（可选）"), { target: { value: "用户保留的范围" } });
  await waitFor(() => expect(screen.getByText("invalid_research_date")).toBeTruthy());
  fireEvent.change(screen.getByLabelText("截至日期"), { target: { value: "2026-09-02" } });
  await waitFor(async () => expect((await f.editor.read()).status).toBe("waiting"));
  fireEvent.click(screen.getByRole("button", { name: "开始调研" }));
  await waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  expect(f.submit).toHaveBeenCalledWith(expect.objectContaining({ parameters: expect.objectContaining({ asOfDate: "2026-09-02", focusScope: "用户保留的范围" }) }));
});

it("does not recover a lock whose revision another writer replaced", async () => {
  const f = await binding("research", "research.submit", { itemId: "topic", companyId: "company", direction: "product_and_technology", asOfDate: "2026-09-01" });
  function Form() { const { control, error } = useInteractionForm(f.editor); return control ? <><CompanyResearchModal topicName="主题" companyName="公司" control={scopeControl(control, "parameters")!} onClose={() => {}} onStart={() => control.confirm()} />{error && <p role="alert">{error}</p>}</> : null; }
  render(<Form />);
  fireEvent.change(await screen.findByLabelText("截至日期"), { target: { value: "" } });
  await screen.findByText("invalid_research_date");
  f.replaceLock();
  fireEvent.change(screen.getByLabelText("截至日期"), { target: { value: "2026-09-02" } });
  await screen.findByText("revision_changed");
  expect((await f.editor.read()).snapshot.values).toMatchObject({ parameters: { asOfDate: "2026-09-01" } });
  expect(f.submit).not.toHaveBeenCalled();
});

it("does not replay a failed lock-acquisition patch after refresh and an unrelated edit", async () => {
  const f = await binding("topic", "topics.create", { industry: "初始主题", notes: "初始备注" });
  const api = makeFakeApi();
  function Form() { const { control, error } = useInteractionForm(f.editor); return control ? <><ResearchItemModal api={api} control={control} onClose={() => {}} onSaved={() => {}} />{error && <p role="alert">{error}</p>}</> : null; }
  render(<Form />);
  await screen.findByLabelText("主题名称");
  await f.modelPatch({ industry: "远程最新主题" });
  fireEvent.change(screen.getByLabelText("主题名称"), { target: { value: "未获锁的本地主题" } });
  await screen.findByText(/未获锁的本地主题/);
  await act(async () => f.notify());
  await waitFor(() => expect((screen.getByLabelText("主题名称") as HTMLInputElement).value).toBe("远程最新主题"));
  fireEvent.change(screen.getByLabelText("备注（可选）"), { target: { value: "新备注" } });
  await waitFor(async () => expect((await f.editor.read()).snapshot.values).toEqual({ industry: "远程最新主题", notes: "新备注" }));
  expect(screen.getByText(/未获锁的本地主题/)).toBeTruthy();
  expect(f.submit).not.toHaveBeenCalled();
});

it.each([{ finalState: "known", viaNone: true }, { finalState: "unknown", viaNone: true }, { finalState: "unknown", viaNone: false }] as const)("submits profile website state $finalState (via none: $viaNone)", async ({ finalState, viaNone }) => {
  const api = makeFakeApi();
  const company = { id: "company", itemId: "topic", name: "公司", officialWebsite: "https://example.com", profileStatus: "ready", normalizedName: "公司", createdAt: "", updatedAt: "" } as unknown as Company;
  const updateCompany = vi.fn((_id, profile) => ({ ...company, ...profile }));
  const business = createBusinessActions({ industryResearch: { getItem: () => ({ industry: "主题" }), listCompanies: () => [company], updateCompany } } as unknown as CompanyResearchOperationServices);
  const details = await business.handle("companies.get", { itemId: "topic", companyId: "company" });
  const expectedRevision = (details!.data as unknown as { item: { profileRevision: string } }).item.profileRevision;
  const f = await binding("company-profile", "companies.update", { itemId: "topic", companyId: "company", expectedRevision, profile: { name: company.name, officialWebsite: company.officialWebsite } });
  function Form() { const { control, error } = useInteractionForm(f.editor); return control ? <><CompanyProfileForm api={api} company={company} control={scopeControl(control, "profile")!} onCancel={() => {}} onSaved={() => {}} />{error && <p role="alert">{error}</p>}</> : null; }
  render(<Form />);
  await screen.findByLabelText("官方网站状态");
  if (viaNone) {
    fireEvent.change(screen.getByLabelText("官方网站状态"), { target: { value: "none" } });
    await waitFor(async () => expect((await f.editor.read()).snapshot.values).toMatchObject({ profile: { officialWebsite: null } }));
  }
  fireEvent.change(screen.getByLabelText("官方网站状态"), { target: { value: finalState } });
  if (finalState === "known") expect((screen.getByLabelText("官方网站") as HTMLInputElement).value).toBe(company.officialWebsite);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
  const input = f.submit.mock.calls[0]![0];
  expect(input.profile.officialWebsite).toEqual(finalState === "known" ? company.officialWebsite : { state: "unknown" });
  await business.handle("companies.update", input);
  const savedProfile = updateCompany.mock.calls[0]![1];
  if (finalState === "known") expect(savedProfile.officialWebsite).toBe(company.officialWebsite);
  else expect(savedProfile).not.toHaveProperty("officialWebsite");
  expect(api.industryResearch.updateCompany).not.toHaveBeenCalled();
});

it.each(["companies.recognize", "companies.add"])("prepares import's real component at the matching stage for %s", async actionId => {
  const f = await binding("companies-import", actionId, actionId === "companies.add" ? { itemId: "topic", companies: [{ name: "公司" }] } : { itemId: "topic", text: "公司" });
  function Form() { const { control } = useInteractionForm(f.editor); return control ? <ImportCompaniesModal api={makeFakeApi()} itemId="topic" control={control} onClose={() => {}} onCompaniesAdded={() => {}} /> : null; }
  render(<Form />);
  const name = actionId === "companies.add" ? "确认导入" : "识别公司";
  const button = await screen.findByRole("button", { name }); expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button); await waitFor(() => expect(f.submit).toHaveBeenCalledOnce());
});
