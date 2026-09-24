import { useEffect, useState } from "react";
import type { CapabilityInteractionEditor } from "@deepfield/capability-sdk";
import type { CompanyResearchApi } from "../contracts/api.js";
import type { CapabilityItem, ItemCompanyView, ResearchRun } from "../contracts/index.js";
import { Modal } from "../../../apps/desktop/src/renderer/components/Modal.js";
import { ResearchItemModal } from "./ResearchItemModal.js";
import { AddCompaniesModal } from "./AddCompaniesModal.js";
import { ImportCompaniesModal } from "./ImportCompaniesModal.js";
import { CompanyProfileForm } from "./CompanyProfileModal.js";
import { CompanyIdentityConfirmationModal } from "./CompanyIdentityConfirmationModal.js";
import { CompanyResearchModal } from "./CompanyResearchModal.js";
import { BatchCompanyResearchModal } from "./BatchCompanyResearchModal.js";
import { WordExportChoiceModal } from "./CompanyResearchPanel.js";
import { scopeControl, useInteractionForm } from "./form-control.js";
import { ConfirmModal } from "./ConfirmModal.js";

/** Dispatches the package catalog to its existing UI. No fields or business rules live in the host. */
export function CompanyFormView({ api, editor, active, dirtyRef, onItemSaved, onCompaniesAdded, onCompanySaved, onResearchStarted }: {
  api: CompanyResearchApi; editor: CapabilityInteractionEditor; active: boolean; dirtyRef: { current: boolean };
  onItemSaved(item: CapabilityItem): void;
  onCompaniesAdded(companies: ItemCompanyView[]): void;
  onCompanySaved(company: ItemCompanyView): void;
  onResearchStarted(): void;
}) {
  const { state, control, error } = useInteractionForm(editor);
  const [context, setContext] = useState<{ item?: CapabilityItem; companies: ItemCompanyView[]; run?: ResearchRun }>();
  const [contextError, setContextError] = useState<string>();
  const values = control?.values;
  const itemId = values?.itemId ?? values?.parameters?.itemId;
  const companyId = values?.companyId ?? values?.parameters?.companyId;
  const runId = values?.runId;
  const deletionTitle = state?.formId === "topics-delete" ? "删除主题" : state?.formId === "companies-remove" ? "移除公司" : state?.formId === "report-delete" ? "删除报告" : undefined;
  useEffect(() => {
    let current = true;
    if (!state || deletionTitle) return;
    setContextError(undefined);
    void Promise.all([itemId ? api.industryResearch.getItem(itemId) : undefined, itemId ? api.industryResearch.listCompanies(itemId) : [], runId ? api.companyResearch.getRun(itemId, companyId, runId) : undefined]).then(([item, companies, run]) => { if (current) setContext({ ...(item ? { item } : {}), companies, ...(run ? { run } : {}) }); }).catch(() => { if (current) setContextError("读取表单目标失败，请重试"); });
    return () => { current = false; };
  }, [api, itemId, companyId, runId, !!state, deletionTitle]);
  const terminal = !!state && ["answered", "cancelled", "invalidated", "submitted", "succeeded", "failed", "uncertain"].includes(state.status);
  dirtyRef.current = !!state && !terminal;
  useEffect(() => () => { dirtyRef.current = false; }, [dirtyRef]);
  if (!control || !state || terminal) return null;
  const close = () => { void control.cancel(); };
  const company = context?.companies.find(candidate => candidate.id === companyId);
  const common = { active, api, onClose: close };
  const renderForm = () => {
  if (deletionTitle) return <ConfirmModal title={deletionTitle} message={state.snapshot.summary ?? deletionTitle} confirmLabel="确认删除"
    active={active} busy={state.status === "executing"} disabled={state.status !== "waiting" || !state.snapshot.readyToSubmit}
    error={error} onClose={close} onConfirm={() => { void control.confirm().catch(() => {}); }} />;
  if (state.formId === "topic") return <ResearchItemModal {...common} {...(state.actionId === "topics.update" && context?.item ? { item: context.item } : {})} control={state.actionId === "topics.update" ? scopeControl(control, "changes")! : control} onSaved={onItemSaved} />;
  if (!context) return <p role="status">正在读取表单…</p>;
  if (state.formId === "companies-add") return <AddCompaniesModal {...common} itemId={itemId} control={control} onCompaniesAdded={onCompaniesAdded} />;
  if (state.formId === "companies-import") return <ImportCompaniesModal {...common} itemId={itemId} control={control} onCompaniesAdded={onCompaniesAdded} />;
  if (state.formId === "company-profile" && company) return <Modal title="编辑公司基本信息" active={active} onClose={close}><CompanyProfileForm api={api} company={company} control={scopeControl(control, "profile")!} onCancel={close} onSaved={onCompanySaved} /></Modal>;
  if (state.formId === "company-identity" && company) return <CompanyIdentityConfirmationModal {...common} company={company} control={scopeControl(control, "identity")!} onConfirmed={onResearchStarted} />;
  if (state.formId === "research" && company && context.item) return <CompanyResearchModal active={active} topicName={context.item.industry} companyName={company.name} control={scopeControl(control, state.actionId === "research.submit" ? "parameters" : "input")!} mode={state.actionId === "research.retryFailed" ? "retry" : "start"} onClose={close} closeOnSubmit={false} onStart={() => control.confirm()} />;
  if (state.formId === "research-batch" && context.item) return <BatchCompanyResearchModal {...common} item={context.item} companies={context.companies} control={control} onStarted={onResearchStarted} />;
  if (state.formId === "report-export" && context.run) return <WordExportChoiceModal control={scopeControl(control, "selection")!} availableRaw={context.run.schemaVersion === "company-research-report-v1" ? !!context.run.rawReportText : !!context.run.reportText} availableStructured={context.run.schemaVersion === "company-research-report-v1" && !!context.run.structuredContent} selection={values.selection ?? { raw: false, structured: false }} busy={false} onChange={selection => control.edit({ selection })} onClose={close} onConfirm={() => { void control.confirm().catch(() => {}); }} />;
  return <p role="alert">表单目标不存在或已失效。</p>;
  };
  return <>{(error || contextError) && <p role="alert">{error || contextError}</p>}<fieldset disabled={state.status === "executing"} style={{ border: 0, padding: 0, margin: 0 }}>{renderForm()}</fieldset></>;
}
