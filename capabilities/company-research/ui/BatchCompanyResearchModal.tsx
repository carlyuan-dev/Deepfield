import { useMemo, useState } from "react";
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";
import type { BatchResearchEntryInput, CapabilityItem, ItemCompanyView, StartCompanyResearchInput } from "../contracts/index.js";
import { Modal } from "../../../apps/desktop/src/renderer/components/Modal.js";
import { CompanyResearchModal } from "./CompanyResearchModal.js";
import { researchActionError } from "./research-error-presentation.js";

interface Props { api: DesktopApi; item: CapabilityItem; companies: ItemCompanyView[]; companyResearchStatuses?: ReadonlyMap<string, string>; active?: boolean; onClose(): void; onStarted(): void; onOpenSettings?(module: "llm" | "search"): void; }
const today = () => new Date().toLocaleDateString("sv-SE");
const reportDate = (timestamp: string) => new Date(timestamp).toLocaleDateString("sv-SE");
const profileStatus = (company: ItemCompanyView): string | undefined => company.profileStatus === "ready" ? undefined
  : company.profileStatus === "pending" ? "公司资料尚未就绪，暂不可调研"
    : company.profileStatus === "enriching" ? "公司资料补全中" : "公司资料补全失败";
export function BatchCompanyResearchModal({ api, item, companies, companyResearchStatuses = new Map(), active = true, onClose, onStarted, onOpenSettings }: Props) {
  const [step, setStep] = useState<"select" | "common" | "confirm">("select");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [common, setCommon] = useState<StartCompanyResearchInput>({ direction: "product_and_technology", asOfDate: today() });
  const [overrides, setOverrides] = useState<Map<string, StartCompanyResearchInput>>(new Map());
  const [editing, setEditing] = useState<string>(); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<ReturnType<typeof researchActionError>>();
  const ordered = useMemo(() => companies.filter((company) => selected.has(company.id)), [companies, selected]);
  const context = (companyName: string) => ({ topicName: item.industry, ...(item.researchScope ? { topicScope: item.researchScope } : {}), companyName });
  if (editing) {
    const company = companies.find((entry) => entry.id === editing)!;
    return <CompanyResearchModal {...context(company.name)} active={active} initial={overrides.get(editing) ?? common} title={`编辑 ${company.name}`} submitLabel="确认修改" submittingLabel="正在保存…" closeOnSubmit={false} onClose={() => setEditing(undefined)} onStart={async (input) => { setOverrides((current) => new Map(current).set(editing, input)); setEditing(undefined); }} />;
  }
  if (step === "common") return <CompanyResearchModal {...context("所选公司")} active={active} initial={common} title="批量调研 · 共同设置" submitLabel="下一步" submittingLabel="正在保存…" cancelLabel="上一步" closeOnSubmit={false} onClose={() => setStep("select")} onStart={async (input) => { setCommon(input); setStep("confirm"); }} />;
  const submit = async (): Promise<void> => {
    if (submitting) return; setSubmitting(true); setError(undefined);
    const entries: BatchResearchEntryInput[] = ordered.map((company) => ({ companyId: company.id, input: overrides.get(company.id) ?? common }));
    try { await api.companyResearchBatch.start(item.id, entries); onStarted(); onClose(); }
    catch (reason) { setError(researchActionError(reason, "start")); setSubmitting(false); }
  };
  const footer = step === "select"
    ? <div className="modal-actions modal-footer batch-research-footer"><button onClick={onClose}>取消</button><button className="primary-button" disabled={!selected.size} onClick={() => setStep("common")}>下一步</button></div>
    : <div className="modal-actions modal-footer batch-research-footer"><button disabled={submitting} onClick={() => setStep("common")}>上一步</button><button className="primary-button" disabled={submitting} onClick={() => void submit()}>{submitting ? "正在启动…" : "开始调研"}</button></div>;
  return <Modal title="批量调研公司" active={active} onClose={submitting ? () => {} : onClose}><div className="modal-body batch-research-modal">
    {step === "select" ? <>
      <p className="muted">选择要调研的公司（已选 {selected.size} 家）</p>
      <div className="batch-select-actions"><button onClick={() => setSelected(new Set(companies.filter((company) => company.profileStatus === "ready" && !companyResearchStatuses.has(company.id)).map((company) => company.id)))}>全选可用公司</button><button onClick={() => setSelected(new Set())}>清空</button></div>
      <ul className="batch-company-list">{companies.map((company) => {
        const ready = company.profileStatus === "ready";
        const researchStatus = companyResearchStatuses.get(company.id);
        const status = profileStatus(company) ?? researchStatus;
        const summary = company.reportSummary && company.reportSummary.count > 0 ? company.reportSummary : undefined;
        return <li className="batch-company-row" key={company.id}>
          <label className="batch-company-select"><input type="checkbox" aria-label={`选择 ${company.name}`} disabled={!ready || researchStatus !== undefined} checked={selected.has(company.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(company.id)) next.delete(company.id); else next.add(company.id); return next; })} /><span className="batch-company-name" title={company.name}>{company.name}</span></label>
          {status && <small className="batch-company-status">{status}</small>}
          {summary && <small className="batch-company-report" aria-label={`报告 ${summary.count} 份 最新创建于 ${reportDate(summary.latestCreatedAt)}`}><span>报告 {summary.count} 份</span><span>最新创建于 <time dateTime={summary.latestCreatedAt}>{reportDate(summary.latestCreatedAt)}</time></span></small>}
        </li>;
      })}</ul>
    </> : <>
      <p className="muted">确认 {ordered.length} 家公司的调研设置</p>
      {error && <p className="error" role="alert">{error.message} {error.settingsModule && onOpenSettings && <button onClick={() => onOpenSettings(error.settingsModule!)}>前往设置</button>}</p>}
      <ul className="batch-confirm-list">{ordered.map((company) => <li key={company.id} data-testid={`batch-confirm-${company.id}`}><strong>{company.name}</strong><span>{overrides.has(company.id) && <small>已修改</small>}<button aria-label={`编辑 ${company.name}`} onClick={() => setEditing(company.id)}>编辑</button></span></li>)}</ul>
    </>}
  </div>{footer}</Modal>;
}
