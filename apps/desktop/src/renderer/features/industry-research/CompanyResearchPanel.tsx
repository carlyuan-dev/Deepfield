import { useState } from "react";
import { COMPANY_RESEARCH_TEMPLATES, type DesktopApi, type KeyResearchRun, type ResearchRunSummary } from "@deepfield/contracts";
import { LinkifiedText } from "../../components/LinkifiedText.js";
import { CompanyResearchModal, type ResearchContextProps } from "./CompanyResearchModal.js";
import { StructuredResearchReport } from "./StructuredResearchReport.js";
import { ResearchReportContext } from "./ResearchReportContext.js";
import { useCompanyResearch } from "./use-company-research.js";

export interface CompanyResearchPanelProps extends ResearchContextProps {
  api: DesktopApi;
  itemId: string;
  companyId: string;
}
function runLabel(run: ResearchRunSummary): string {
  const date = new Date(run.completedAt ?? run.createdAt);
  const timestamp = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date) : "时间未知";
  return `${timestamp} · ${run.schemaVersion === "legacy-freeform-v1" ? "旧版原始报告" : `${COMPANY_RESEARCH_TEMPLATES[run.direction].title} · 截至 ${run.asOfDate}`}${run.status === "structure_failed" ? " · 整理失败" : ""}`;
}
function ReportTabs({ run, rawText }: { run: KeyResearchRun | undefined; rawText: string }) {
  const completed = run?.status === "completed";
  const [tab, setTab] = useState<"structured" | "raw">("raw");
  return <>
    {run && <ResearchReportContext run={run} />}
    <div role="tablist" aria-label="报告视图" className="research-tabs">
      <button role="tab" id="research-raw-tab" aria-controls="research-report-body" aria-selected={tab === "raw"} onClick={() => setTab("raw")}>原始调研报告</button>
      {completed && <button role="tab" id="research-structured-tab" aria-controls="research-report-body" aria-selected={tab === "structured"} onClick={() => setTab("structured")}>结构化报告</button>}
    </div>
    <div role="tabpanel" id="research-report-body" aria-labelledby={tab === "structured" ? "research-structured-tab" : "research-raw-tab"}>
      {tab === "structured" && run ? <StructuredResearchReport run={run} /> : <div className="company-report-text"><LinkifiedText text={rawText} /></div>}
    </div>
  </>;
}

// The target key resets modal/tab state immediately as well as hook subscriptions.
export function CompanyResearchPanel(props: CompanyResearchPanelProps) {
  return <ResearchTarget key={`${props.itemId}:${props.companyId}`} {...props} />;
}
function ResearchTarget({ api, itemId, companyId, ...context }: CompanyResearchPanelProps) {
  const research = useCompanyResearch(api, itemId, companyId);
  const [modalOpen, setModalOpen] = useState(false);
  const active = research.state.active;
  const run = research.selectedRun;
  const latest = research.state.runs.find((entry) => entry.schemaVersion === "company-research-report-v1");
  const occupied = research.state.globalActiveRun !== null;
  const otherActive = occupied && (research.state.globalActiveRun!.itemId !== itemId || research.state.globalActiveRun!.companyId !== companyId);
  const summary = research.state.runs.find((entry) => entry.id === research.selectedRunId);
  const status = active?.run.status ?? summary?.status;
  const rawText = run?.schemaVersion === "company-research-report-v1"
    ? run.rawReportText ?? (active?.draftText || research.rawDraftText)
    : active?.draftText || research.rawDraftText;
  return <section className="company-research-panel" aria-labelledby="company-research-title">
    <div className="company-research-heading">
      <div><h2 id="company-research-title">公司调研</h2><p className="muted">AI 调研结果仅供参考，重要事实仍需人工核验。</p></div>
      {!active && <button className="primary-button" disabled={research.loading || research.pending || occupied} onClick={() => setModalOpen(true)}>{research.state.runs.length ? "重新调研" : "开始调研"}</button>}
    </div>
    {otherActive && <p role="status">其他公司正在调研，请稍后再试。</p>}
    {research.error && !modalOpen && <p className="error" role="alert">{research.error} <button onClick={research.reload}>重新加载</button></p>}
    {research.loading ? <p className="muted">加载调研状态…</p> : <>
      {active && <div className="company-research-status" role="status">
        <div><strong>{active.run.status === "researching" ? "正在联网调研…" : "正在整理结构化报告…"}</strong><span>{research.elapsedLabel}</span></div>
        <button disabled={research.pending} onClick={() => void research.cancel()}>取消调研</button>
      </div>}
      {!active && research.state.runs.length > 0 && <label className="company-report-version">报告版本<select value={research.selectedRunId} onChange={(event) => research.selectRun(event.target.value)}>
        {research.state.runs.map((entry) => <option key={entry.id} value={entry.id}>{runLabel(entry)}</option>)}
      </select></label>}
      {status === "structure_failed" && <div className="company-research-status"><p role="status">整理失败，请重试</p><button disabled={research.pending || occupied || !run} onClick={() => void research.retry()}>重新整理</button></div>}
      {active?.run.status === "researching" ? <div className="company-report-text" aria-live="polite">{active.draftText ? <LinkifiedText text={active.draftText} /> : <span className="muted">报告生成后将在这里显示。</span>}</div>
        : run?.schemaVersion === "legacy-freeform-v1" ? <div>
          <h3>旧版原始报告</h3>
          <dl className="research-context"><div><dt>调研时间范围</dt><dd>{run.timeScope}</dd></div>{run.customRequirements && <div><dt>补充要求</dt><dd>{run.customRequirements}</dd></div>}</dl>
          <div className="company-report-text"><LinkifiedText text={run.reportText} /></div>
        </div>
        : run?.schemaVersion === "company-research-report-v1" || active?.run.status === "structuring" || (status === "structure_failed" && rawText) ? <ReportTabs key={`${research.selectedRunId}:${status}:${run?.status ?? "loading"}`} run={run?.schemaVersion === "company-research-report-v1" ? run : undefined} rawText={rawText} />
        : research.detailLoading ? <p className="muted">加载调研报告…</p>
        : research.state.runs.length === 0 ? <p className="muted company-research-empty">还没有调研报告。</p> : null}
    </>}
    {modalOpen && <CompanyResearchModal {...context} {...(latest?.schemaVersion === "company-research-report-v1" ? { initial: latest } : {})} disabled={occupied} onClose={() => setModalOpen(false)} onStart={research.start} />}
  </section>;
}
