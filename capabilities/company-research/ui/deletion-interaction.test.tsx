// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatInteractionCoordinator } from "@deepfield/application";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import type { CapabilityInteractionEditor } from "@deepfield/capability-sdk";
import { CompanyFormView } from "./CompanyFormView.js";
import { createCompanyFormProvider } from "../actions/form-bindings.js";
import { createBusinessActions } from "../actions/business-actions.js";
import { ResearchDrafts, type ProtocolStore } from "../actions/drafts.js";
import type { CompanyResearchOperationServices } from "../main.js";
import type { CompanyResearchService } from "../application/company-research-service.js";
import { makeFakeApi } from "../../../apps/desktop/src/renderer/renderer-test-helpers.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
const cases = [
  { formId: "topics-delete", actionId: "topics.delete", input: { itemIds: ["topic"] }, label: "删除主题", parent: "topics", names: ["半导体"], parentInput: {} },
  { formId: "companies-remove", actionId: "companies.remove", input: { itemId: "topic", companyIds: ["company"] }, label: "移除公司", parent: "companies", names: ["半导体", "目标公司"], parentInput: { itemId: "topic" } },
  { formId: "report-delete", actionId: "reports.delete", input: { itemId: "topic", companyId: "company", runId: "run" }, label: "删除报告", parent: "company", names: ["半导体", "目标公司", "技术", "2026-09-23"], parentInput: { itemId: "topic", companyId: "company" } },
] as const;

async function fixture(testCase: typeof cases[number]) {
  const db = openDatabase(":memory:"); migrate(db); cleanup.push(() => db.close());
  const repos = createRepositories(db); const conversationId = repos.conversations.create().id;
  const deleted = vi.fn();
  const business = createBusinessActions({ industryResearch: {
    getItem: () => ({ id: "topic", industry: "半导体" }), listCompanies: () => [{ id: "company", name: "目标公司" }],
    deleteItems: deleted, removeCompany: deleted, removeCompanies: deleted,
  }, companyResearch: { getRun: () => ({ id: "run", schemaVersion: "company-research-report-v1", template: { title: "技术" }, createdAt: "2026-09-23T00:00:00Z" }), deleteRun: deleted } } as unknown as CompanyResearchOperationServices);
  const rows = new Map<string, string>();
  const drafts = new ResearchDrafts({ getDraft: (id: string) => rows.get(id), saveDraft: (id: string, value: string) => rows.set(id, value), deleteDraft: (id: string) => rows.delete(id) } as unknown as ProtocolStore, {} as CompanyResearchService);
  const provider = createCompanyFormProvider(drafts, (id, input) => { const copy = business.present(id, input); return `${copy.title}\n${copy.fields.map(field => `${field.label}：${field.value}`).join("\n")}`; });
  const snapshot = await provider.prepare(testCase.formId, testCase.actionId, testCase.input);
  expect(snapshot.parentView).toEqual({ capabilityId: "company-research", viewId: testCase.parent, input: testCase.parentInput });
  const listeners = new Set<() => void>();
  const coordinator = new ChatInteractionCoordinator(repos.chatInteractions, new Map([["capability", {
    read: async () => ({ version: snapshot.draft.revision, summary: snapshot.summary! }),
    execute: async () => { await business.handle(testCase.actionId, (await provider.submission(snapshot.draft)).input); return { status: "succeeded" as const, summary: "完成" }; },
    reconcile: async () => "unknown" as const, release: async () => provider.release(snapshot.draft),
  }]]), () => listeners.forEach(fn => fn()));
  const interaction = await coordinator.create({ conversationId, requestId: "r", toolCallId: "t" }, { kind: "approval", summary: "", operation: { provider: "capability", operationId: "delete", contractVersion: "1" } });
  const respond = (decision: "approve" | "cancel", source: "chat_button" | "form_button", revision = interaction.revision) => coordinator.respond({ interactionId: interaction.id, expectedRevision: revision, response: { kind: "decision", decision } }, { conversationId, source });
  const editor: CapabilityInteractionEditor = {
    read: async () => ({ revision: coordinator.get(interaction.id)!.revision, status: coordinator.get(interaction.id)!.status, formId: testCase.formId, actionId: testCase.actionId, snapshot }),
    beginEdit: vi.fn(), update: vi.fn(), transition: vi.fn(),
    respond: async (revision, decision) => { await respond(decision, "form_button", revision); }, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
  const api = makeFakeApi(); const dirtyRef = { current: false };
  render(<CompanyFormView api={api} editor={editor} active dirtyRef={dirtyRef} onItemSaved={vi.fn()} onCompanySaved={vi.fn()} onCompaniesAdded={vi.fn()} onResearchStarted={vi.fn()} />);
  return { api, dirtyRef, deleted, respond, coordinator, interaction };
}

it.each(cases)("shows $actionId targets in the native modal and shares one execution across both entries", async testCase => {
  const f = await fixture(testCase);
  const dialog = await screen.findByRole("dialog", { name: testCase.label });
  for (const name of testCase.names) expect(dialog.textContent).toContain(name);
  expect(f.dirtyRef.current).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await act(async () => { await f.respond("approve", "chat_button"); });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.deleted).toHaveBeenCalledOnce();
  expect(f.api.industryResearch.deleteItems).not.toHaveBeenCalled();
  expect(f.dirtyRef.current).toBe(false);
});

it("cancels the bound deletion and closes the modal without invoking the native delete API", async () => {
  const f = await fixture(cases[0]);
  fireEvent.click(await screen.findByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(f.deleted).not.toHaveBeenCalled();
  expect(f.api.industryResearch.deleteItems).not.toHaveBeenCalled();
  expect(f.coordinator.get(f.interaction.id)?.status).toBe("cancelled");
  expect(f.dirtyRef.current).toBe(false);
});
