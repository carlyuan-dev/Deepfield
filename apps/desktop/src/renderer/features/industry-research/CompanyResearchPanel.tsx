import { useState } from "react";
import { COMPANY_RESEARCH_TEMPLATES, type CompanyResearchState, type DesktopApi, type KeyResearchRun, type ResearchRunSummary } from "@deepfield/contracts";
import { MarkdownMessage } from "../../components/MarkdownMessage.js";
import { CompanyResearchModal, type ResearchContextProps } from "./CompanyResearchModal.js";
import { ConfirmModal } from "./ConfirmModal.js";
import { StructuredResearchReport } from "./StructuredResearchReport.js";
import { ResearchReportContext } from "./ResearchReportContext.js";
import { useCompanyResearch } from "./use-company-research.js";

export interface CompanyResearchPanelProps extends ResearchContextProps {
  api: DesktopApi;
  itemId: string;
  companyId: string;
}
function runTimestamp(run: ResearchRunSummary): string {
  const date = new Date(run.completedAt ?? run.createdAt);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date) : "时间未知";
}
function runStatusLabel(run: ResearchRunSummary): string {
  if (run.status === "research_failed") return "调研失败";
  if (run.status === "structure_failed") return "整理失败";
  return "已完成";
}
function runLabel(run: ResearchRunSummary): string {
  const failure = run.status === "research_failed" || run.status === "structure_failed" ? "（失败待重试）" : "";
  return `${runTimestamp(run)} · ${run.schemaVersion === "legacy-freeform-v1" ? "旧版原始报告" : `${COMPANY_RESEARCH_TEMPLATES[run.direction].title} · 截至 ${run.asOfDate}`}${failure}`;
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
      {tab === "structured" && run ? <StructuredResearchReport run={run} /> : <div className="company-report-text"><MarkdownMessage content={rawText} /></div>}
    </div>
  </>;
}

type ResearchActivity = NonNullable<NonNullable<CompanyResearchState["active"]>["latestActivity"]>;
function activityLabel(activity: ResearchActivity): string {
  if (activity.name === "research_synthesis") return activity.summary ?? "资料检索完成，正在生成原始报告…";
  const subject = activity.summary ? `：${activity.summary}` : "";
  if (activity.name === "web_search") {
    if (activity.status === "running") return `正在搜索${subject}`;
    if (activity.status === "failed") return `搜索失败${subject}`;
    if (activity.status === "skipped") return `已跳过搜索${subject}`;
    if (activity.status === "reused") return `复用搜索结果${subject}`;
    return `已完成搜索${subject}`;
  }
  if (activity.name === "read_webpage") {
    if (activity.status === "running") return `正在读取网页${subject}`;
    if (activity.status === "failed") return `网页读取失败${subject}`;
    if (activity.status === "skipped") return `已跳过网页${subject}`;
    if (activity.status === "reused") return `复用网页内容${subject}`;
    return `已读取网页${subject}`;
  }
  return activity.summary ?? `${activity.name} · ${activity.status}`;
}

// The target key resets modal/tab state immediately as well as hook subscriptions.
export function CompanyResearchPanel(props: CompanyResearchPanelProps) {
  return <ResearchTarget key={`${props.itemId}:${props.companyId}`} {...props} />;
}
function ResearchTarget({ api, itemId, companyId, ...context }: CompanyResearchPanelProps) {
  const research = useCompanyResearch(api, itemId, companyId);
  const [newReportModalOpen, setNewReportModalOpen] = useState(false);
  const [retryModalOpen, setRetryModalOpen] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const active = research.state.active;
  const run = research.selectedRun;
  const latest = research.state.runs.find((entry) => entry.schemaVersion === "company-research-report-v1");
  const occupied = research.state.globalActiveRun !== null;
  const otherActive = occupied && (research.state.globalActiveRun!.itemId !== itemId || research.state.globalActiveRun!.companyId !== companyId);
  const summary = research.state.runs.find((entry) => entry.id === research.selectedRunId);
  const status = active?.run.status ?? summary?.status;
  const failed = summary?.status === "research_failed" || summary?.status === "structure_failed";
  const modalOpen = newReportModalOpen || retryModalOpen;
  const rawText = run?.schemaVersion === "company-research-report-v1"
    ? run.rawReportText ?? (active?.draftText || research.rawDraftText)
    : active?.draftText || research.rawDraftText;
  const confirmDeletion = async () => {
    setDeleteError(undefined);
    try {
      await research.deleteSelected();
      setDeleteConfirmationOpen(false);
    } catch {
      setDeleteError("删除调研报告失败，请重试");
    }
  };
  return <section className="company-research-panel" aria-labelledby="company-research-title">
    <div className="company-research-heading">
      <div><h2 id="company-research-title">公司调研</h2><p className="muted">AI 调研结果仅供参考，重要事实仍需人工核验。</p></div>
      {!active && <div className="company-research-actions">
        {failed && <button disabled={research.loading || research.pending || occupied} onClick={() => setRetryModalOpen(true)}>重新尝试</button>}
        <button className="primary-button" disabled={research.loading || research.pending || occupied} onClick={() => setNewReportModalOpen(true)}>{research.state.runs.length ? "新的调研" : "开始调研"}</button>
      </div>}
    </div>
    {otherActive && <p role="status">其他公司正在调研，请稍后再试。</p>}
    {research.error && !modalOpen && <p className="error" role="alert">{research.error} <button onClick={research.reload}>重新加载</button></p>}
    {research.loading ? <p className="muted">加载调研状态…</p> : <>
      {active && <div className="company-research-status" role="status">
        <div><div className="company-research-status-line"><span className="company-research-spinner" aria-hidden="true" /><strong>{active.run.status === "researching" ? "正在联网调研…" : "正在整理结构化报告…"}</strong>
          {active.latestActivity && <span className="company-research-activity">{activityLabel(active.latestActivity)}</span>}</div>
          <span>{research.elapsedLabel}</span></div>
        <button disabled={research.pending} onClick={() => void research.cancel()}>取消调研</button>
      </div>}
      {!active && research.state.runs.length > 0 && <div className="company-report-version-controls">
        <label className="company-report-version">报告版本<select value={research.selectedRunId} onChange={(event) => research.selectRun(event.target.value)}>
          {research.state.runs.map((entry) => <option key={entry.id} value={entry.id}>{runLabel(entry)}</option>)}
        </select></label>
        <button className="danger-button" disabled={research.pending || occupied || !summary} onClick={() => { setDeleteError(undefined); setDeleteConfirmationOpen(true); }}>删除此报告</button>
      </div>}
      {status === "research_failed" && <div className="company-research-status"><p role="status">{research.selectedFailureMessage ?? "调研未完成，请稍后重试"}</p></div>}
      {status === "structure_failed" && <div className="company-research-status"><p role="status">整理失败，请重试</p></div>}
      {active?.run.status === "researching" ? <div className="company-report-text" aria-live="polite">{active.draftText ? <MarkdownMessage content={active.draftText} /> : <span className="muted">报告生成后将在这里显示。</span>}</div>
        : status === "research_failed" ? (run?.schemaVersion === "company-research-report-v1" ? <ResearchReportContext run={run} /> : research.detailLoading ? <p className="muted">加载调研报告…</p> : null)
        : run?.schemaVersion === "legacy-freeform-v1" ? <div>
          <h3>旧版原始报告</h3>
          <dl className="research-context"><div><dt>调研时间范围</dt><dd>{run.timeScope}</dd></div>{run.customRequirements && <div><dt>补充要求</dt><dd>{run.customRequirements}</dd></div>}</dl>
          <div className="company-report-text"><MarkdownMessage content={run.reportText} /></div>
        </div>
        : run?.schemaVersion === "company-research-report-v1" || active?.run.status === "structuring" || (status === "structure_failed" && rawText) ? <ReportTabs key={`${research.selectedRunId}:${status}:${run?.status ?? "loading"}`} run={run?.schemaVersion === "company-research-report-v1" ? run : undefined} rawText={rawText} />
        : research.detailLoading ? <p className="muted">加载调研报告…</p>
        : research.state.runs.length === 0 ? <p className="muted company-research-empty">还没有调研报告。</p> : null}
    </>}
    {newReportModalOpen && <CompanyResearchModal {...context} {...(latest?.schemaVersion === "company-research-report-v1" ? { initial: latest } : {})} disabled={occupied} onClose={() => setNewReportModalOpen(false)} onStart={research.start} />}
    {retryModalOpen && summary?.schemaVersion === "company-research-report-v1" && <CompanyResearchModal {...context} mode="retry" initial={summary} disabled={occupied} onClose={() => setRetryModalOpen(false)} onStart={research.retry} />}
    {deleteConfirmationOpen && summary && <ConfirmModal
      title="删除调研报告"
      message={`确定删除 ${runTimestamp(summary)} 的报告吗？当前状态：${runStatusLabel(summary)}。删除后无法恢复。`}
      confirmLabel="确认删除"
      busy={research.pending}
      disabled={occupied}
      error={deleteError}
      onClose={() => { if (!research.pending) { setDeleteConfirmationOpen(false); setDeleteError(undefined); } }}
      onConfirm={() => void confirmDeletion()}
    />}
  </section>;
}
