import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { chunkRecognitionText } from "@deepfield/contracts";
import type { CapabilityFormProvider, CapabilityFormSnapshot, DraftRef } from "@deepfield/capability-sdk";
import { createActionDefinitions } from "./definitions.js";
import { CAPABILITY_ID, protocolError, type ResearchDrafts } from "./drafts.js";

/** The catalog points at the same components used by the capability's manual entry. */
export const companyForms = [
  { id: "topic", actionIds: ["topics.create", "topics.update"], description: "新建或编辑研究主题", component: "ResearchItemModal" },
  { id: "companies-add", actionIds: ["companies.add"], description: "暂存并确认添加公司", component: "AddCompaniesModal" },
  { id: "companies-import", actionIds: ["companies.recognize", "companies.add"], description: "识别文本或确认导入候选公司", component: "ImportCompaniesModal" },
  { id: "company-profile", actionIds: ["companies.update"], description: "编辑共享公司资料", component: "CompanyProfileForm" },
  { id: "company-identity", actionIds: ["companies.confirmIdentity"], description: "确认公司主体", component: "CompanyIdentityConfirmationModal" },
  { id: "research", actionIds: ["research.submit", "research.retryFailed"], description: "新建或重试公司调研", component: "CompanyResearchModal" },
  { id: "research-batch", actionIds: ["research.submitBatch"], description: "选择公司、统一条件、逐条编辑、最终确认", component: "BatchCompanyResearchModal" },
  { id: "report-export", actionIds: ["reports.exportWord"], description: "选择 Word 导出内容", component: "WordExportChoiceModal" },
  { id: "topics-delete", actionIds: ["topics.delete"], description: "删除研究主题及关联资料", component: "ConfirmModal" },
  { id: "companies-remove", actionIds: ["companies.remove"], description: "从主题移除指定公司", component: "ConfirmModal" },
  { id: "report-delete", actionIds: ["reports.delete"], description: "删除指定报告", component: "ConfirmModal" },
] as const;
type StoredForm = { kind: "form"; formId: string; actionId: string; ref: DraftRef; values: any; step: string; recognition?: { chunks: string[]; index: number; companies: any[] }; released?: boolean };
/** Merge only supplied fields. Arrays are atomic; omitted sibling fields survive model patches. */
export function mergeFormPatch(value: any, patch: any): any {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const plainBase = value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const next = plainBase ? { ...value } : {};
  for (const [key, entry] of Object.entries(patch)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("invalid_patch");
    next[key] = mergeFormPatch(plainBase ? value[key] : undefined, entry);
  }
  return next;
}
export function createCompanyFormProvider(drafts: ResearchDrafts, describeDeletion?: (actionId: string, input: unknown) => string): CapabilityFormProvider & { retainRecognition(itemId: string, text: string, candidates: unknown[]): string | undefined } {
  const actions = createActionDefinitions();
  const activeImports = new Set<string>();
  const definition = (id: string) => { const found = actions.find(action => action.id === id); if (!found) throw protocolError("not_found"); return found; };
  const read = (ref: DraftRef): StoredForm => {
    if (ref.capabilityId !== CAPABILITY_ID) throw protocolError("not_found");
    const raw = drafts.store.getDraft(ref.draftId);
    if (!raw) throw protocolError("not_found");
    const form = JSON.parse(raw) as StoredForm;
    if (form.kind !== "form" || form.released) throw protocolError("expired");
    if (form.ref.revision !== ref.revision) throw protocolError("revision_changed");
    if (form.formId === "companies-import") activeImports.add(ref.draftId);
    if (form.actionId === "research.submit") form.values = drafts.get(form.values.draftRef);
    return form;
  };
  const save = (form: StoredForm) => drafts.store.saveDraft(form.ref.draftId, JSON.stringify(form.actionId === "research.submit" ? { ...form, values: { draftRef: form.values.draftRef } } : form));
  const input = (form: StoredForm) => {
    const { common: _common, editedIds: _editedIds, ...values } = form.values;
    if (form.formId === "companies-import") return form.actionId === "companies.recognize" ? { itemId: values.itemId, text: (form.recognition?.chunks ?? chunkRecognitionText(values.text ?? ""))[form.recognition?.index ?? 0] ?? "" } : { itemId: values.itemId, companies: values.companies?.slice(0, 100) };
    return values;
  };
  const snapshot = (form: StoredForm): CapabilityFormSnapshot => ({
    draft: form.ref, view: { capabilityId: CAPABILITY_ID, viewId: "form", input: { draftId: form.ref.draftId, revision: form.ref.revision } },
    parentView: { capabilityId: CAPABILITY_ID,
      viewId: (form.values.parameters ?? form.values).companyId ? "company" : form.values.itemId ? "companies" : "topics",
      input: Object.fromEntries(["itemId", "companyId"].flatMap(key => {
        const value = (form.values.parameters ?? form.values)[key]; return value ? [[key, value]] : [];
      })) },
    values: form.values, inputSchema: definition(form.actionId).inputSchema, step: form.step,
    summary: ["topics.delete", "companies.remove", "reports.delete"].includes(form.actionId) && describeDeletion
      ? describeDeletion(form.actionId, input(form))
      : [companyForms.find(entry => entry.id === form.formId)?.description, form.values.industry ?? form.values.changes?.industry, form.values.notes ?? form.values.changes?.notes, form.values.companies ? `${form.values.companies.length} 家公司` : undefined, form.values.entries ? `${form.values.entries.length} 条调研` : undefined].filter(Boolean).join(" · "),
    transitions: form.formId === "research-batch" ? (form.step === "select" ? [{ id: "common", label: "下一步" }] : form.step === "common" ? [{ id: "select", label: "上一步" }, { id: "confirm", label: "下一步" }] : [{ id: "common", label: "上一步" }]) : [],
    readyToSubmit: (form.formId !== "research-batch" || form.step === "confirm") && (form.formId !== "report-export" || !!(form.values.selection?.raw || form.values.selection?.structured)) && Value.Check(definition(form.actionId).inputSchema, input(form)),
  });
  return {
    retainRecognition(itemId, text, candidates) {
      const matching = [...activeImports].some(id => { const raw = drafts.store.getDraft(id); if (!raw) return false; const form = JSON.parse(raw) as StoredForm; return form.actionId === "companies.recognize" && form.values.itemId === itemId && input(form).text === text; });
      if (!matching) return undefined;
      const id = randomUUID(); drafts.store.saveDraft(id, JSON.stringify({ kind: "recognition-receipt", itemId, candidates })); return id;
    },
    async prepare(formId, actionId, values) {
      if (!companyForms.some(form => form.id === formId && (form.actionIds as readonly string[]).includes(actionId))) throw protocolError("not_found");
      const form: StoredForm = { kind: "form", formId, actionId, ref: { capabilityId: CAPABILITY_ID, draftId: randomUUID(), revision: randomUUID() }, values: structuredClone(values), step: formId === "research-batch" ? "select" : formId === "companies-import" && actionId === "companies.add" ? "selection" : "edit" };
      if (actionId === "research.submit") drafts.validate(form.values);
      if (formId === "companies-import") activeImports.add(form.ref.draftId);
      save(form); return snapshot(form);
    },
    async read(ref) { return snapshot(read(ref)); },
    async update(ref, patch) {
      const form = read(ref); form.values = mergeFormPatch(form.values, patch);
      if (form.formId === "companies-import" && patch && typeof patch === "object" && "text" in patch) { delete form.recognition; form.actionId = "companies.recognize"; form.step = "edit"; delete form.values.companies; }
      if (form.actionId === "research.submit") form.values = drafts.update(form.values.draftRef, form.values.parameters);
      form.ref = { ...ref, revision: randomUUID() }; save(form); return snapshot(form);
    },
    async transition(ref, transitionId) {
      const form = read(ref);
      if (!snapshot(form).transitions.some(transition => transition.id === transitionId)) throw new Error("invalid_transition");
      if (transitionId !== "select" && !form.values.entries?.length) throw new Error("请选择公司");
      form.step = transitionId; form.ref = { ...ref, revision: randomUUID() }; save(form); return snapshot(form);
    },
    async validate(ref) {
      const form = read(ref);
      const valid = snapshot(form).readyToSubmit;
      return { valid, fieldErrors: valid ? [] : [{ path: "", message: "请完成表单并检查输入" }] };
    },
    async submission(ref) {
      const form = read(ref); if (!snapshot(form).readyToSubmit) throw new Error("invalid_form");
      if (form.formId === "companies-import" && form.actionId === "companies.recognize" && !form.recognition) { form.recognition = { chunks: chunkRecognitionText(form.values.text), index: 0, companies: [] }; save(form); }
      if (form.actionId === "research.submit") drafts.validate(form.values);
      return { actionId: form.actionId, input: input(form), revision: ref.revision };
    },
    async afterAction(ref, actionId, outcome) {
      const form = read(ref);
      if (form.formId !== "companies-import") return;
      if (actionId === "companies.add") {
        if (form.values.companies.length <= 100) return;
        form.values.companies = form.values.companies.slice(100); form.ref = { ...ref, revision: randomUUID() }; save(form);
        return { snapshot: snapshot(form), nextActionId: "companies.add" };
      }
      if (actionId !== "companies.recognize") return;
      const result = outcome as { status?: string; data?: { items?: unknown[]; item?: { recognitionReceiptId?: string } } };
      if (result.status !== "completed" || !Array.isArray(result.data?.items)) return;
      const recognition = form.recognition ?? { chunks: chunkRecognitionText(form.values.text), index: 0, companies: [] };
      const names = new Set(recognition.companies.map(company => company.name.normalize("NFKC").trim().toLowerCase()));
      const receiptId = result.data.item?.recognitionReceiptId;
      const receipt = receiptId ? JSON.parse(drafts.store.getDraft(receiptId) ?? "null") : undefined;
      if (receiptId && (receipt?.kind !== "recognition-receipt" || receipt.itemId !== form.values.itemId)) throw protocolError("not_found");
      for (const company of (receipt?.candidates ?? result.data.items) as any[]) { const name = company.name.normalize("NFKC").trim().toLowerCase(); if (!names.has(name)) { names.add(name); recognition.companies.push(company); } }
      if (receiptId) drafts.store.deleteDraft(receiptId);
      recognition.index++; form.recognition = recognition;
      form.actionId = recognition.index < recognition.chunks.length ? "companies.recognize" : "companies.add";
      form.step = form.actionId === "companies.add" ? "selection" : "recognition";
      form.values = { ...form.values, companies: recognition.companies };
      form.ref = { ...ref, revision: randomUUID() }; save(form);
      return { snapshot: snapshot(form), nextActionId: form.actionId };
    },
    async release(ref) { const form = read(ref); activeImports.delete(ref.draftId); if (form.actionId === "research.submit") drafts.store.deleteDraft(form.values.draftRef.draftId); drafts.store.deleteDraft(form.ref.draftId); },
  };
}
