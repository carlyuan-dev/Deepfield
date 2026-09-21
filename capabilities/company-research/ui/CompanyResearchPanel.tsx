import { useEffect, useRef, useState, type ReactNode } from "react";
import { type CompanyResearchWordExportSelection } from "../contracts/ipc.js";
import type { CompanyResearchApi as DesktopApi } from "../contracts/api.js";
import { researchRetryMode, COMPANY_RESEARCH_TEMPLATES, type CompanyResearchState, type KeyResearchRun, type ResearchRun, type ResearchRunSummary } from "../contracts/index.js";
import { MarkdownMessage } from "../../../apps/desktop/src/renderer/components/MarkdownMessage.js";
import { CompanyResearchModal, type ResearchContextProps } from "./CompanyResearchModal.js";
import { ConfirmModal } from "./ConfirmModal.js";
import { Modal } from "../../../apps/desktop/src/renderer/components/Modal.js";
import { StructuredResearchReport } from "./StructuredResearchReport.js";
import { ResearchReportContext } from "./ResearchReportContext.js";
import { useCompanyResearch } from "./use-company-research.js";

export interface CompanyResearchPanelProps extends ResearchContextProps {
  api: DesktopApi;
  itemId: string;
  companyId: string;
  active?: boolean;
  onOpenSettings?(module: "llm" | "search"): void;
}
function runTimestamp(run: ResearchRunSummary): string {
  const date = new Date(run.completedAt ?? run.createdAt);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date) : "时间未知";
}
function runStatusLabel(run: ResearchRunSummary): string {
  if (run.status === "research_failed") return "调研失败";
  if (run.status === "structure_failed") return "整理失败";
  if (run.searchStatus === "none") return "未成功联网";
  return "已完成";
}
function runLabel(run: ResearchRunSummary): string {
  const failure = run.status === "research_failed" || run.status === "structure_failed" ? "（失败待重试）"
    : run.searchStatus === "none" ? "（未成功联网）" : "";
  return `${runTimestamp(run)} · ${run.schemaVersion === "legacy-freeform-v1" ? "旧版原始报告" : `${COMPANY_RESEARCH_TEMPLATES[run.direction].title} · 截至 ${run.asOfDate}`}${failure}`;
}
function ReportTabs({ run, rawText, exportControl }: { run: KeyResearchRun | undefined; rawText: string; exportControl: ReactNode }) {
  const completed = run?.status === "completed";
  const [tab, setTab] = useState<"structured" | "raw">("raw");
  return <>
    {run && <ResearchReportContext run={run} />}
    <div role="group" aria-label="报告视图与导出" className="research-tabs-toolbar">
      <div role="tablist" aria-label="报告视图" className="research-tabs">
        <button role="tab" id="research-raw-tab" aria-controls="research-report-body" aria-selected={tab === "raw"} onClick={() => setTab("raw")}>原始调研报告</button>
        {completed && <button role="tab" id="research-structured-tab" aria-controls="research-report-body" aria-selected={tab === "structured"} onClick={() => setTab("structured")}>结构化报告</button>}
      </div>
      {exportControl}
    </div>
    <div role="tabpanel" id="research-report-body" aria-labelledby={tab === "structured" ? "research-structured-tab" : "research-raw-tab"}>
      {tab === "structured" && run ? <StructuredResearchReport run={run} /> : <div className="company-report-text"><MarkdownMessage content={rawText} /></div>}
    </div>
  </>;
}

function WordExportChoiceModal({ availableRaw, availableStructured, selection, busy, onChange, onClose, onConfirm }: {
  availableRaw: boolean;
  availableStructured: boolean;
  selection: CompanyResearchWordExportSelection;
  busy: boolean;
  onChange(selection: CompanyResearchWordExportSelection): void;
  onClose(): void;
  onConfirm(): void;
}) {
  return <Modal title="选择导出内容" onClose={busy ? () => undefined : onClose}>
    <div className="modal-body word-export-choice">
      <fieldset disabled={busy}>
        <legend>选择要写入 Word 的报告</legend>
        <label><input type="checkbox" checked={selection.raw} disabled={!availableRaw} onChange={(event) => onChange({ ...selection, raw: event.target.checked })} />原始调研报告</label>
        {!availableRaw && <p className="muted">此版本没有可用的原始调研报告。</p>}
        <label><input type="checkbox" checked={selection.structured} disabled={!availableStructured} onChange={(event) => onChange({ ...selection, structured: event.target.checked })} />结构化报告</label>
        {!availableStructured && <p className="muted">此版本没有可用的结构化报告。</p>}
      </fieldset>
      <div className="modal-actions">
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" type="button" disabled={busy || (!selection.raw && !selection.structured)} onClick={onConfirm}>{busy ? "导出中…" : "确认导出"}</button>
      </div>
    </div>
  </Modal>;
}

type ExportFeedback = { key: string; kind: "saved" | "cancelled" | "error"; message: string };
function hasPersistedReportBody(run: ResearchRun | undefined): boolean {
  if (!run || run.status === "researching" || run.status === "structuring") return false;
  return run.schemaVersion === "legacy-freeform-v1"
    ? run.reportText.trim().length > 0
    : (run.rawReportText?.trim().length ?? 0) > 0;
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
function ResearchTarget({ api, itemId, companyId, active: panelActive = true, onOpenSettings, ...context }: CompanyResearchPanelProps) {
  const research = useCompanyResearch(api, itemId, companyId);
  const [newReportModalOpen, setNewReportModalOpen] = useState(false);
  const [retryModalOpen, setRetryModalOpen] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [exporting, setExporting] = useState(false);
  const [exportChoiceOpen, setExportChoiceOpen] = useState(false);
  const [exportSelection, setExportSelection] = useState<CompanyResearchWordExportSelection>({ raw: false, structured: false });
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback>();
  const exportSequence = useRef(0);
  const exportInFlight = useRef(false);
  const active = research.state.active;
  const run = research.selectedRun;
  const latest = research.state.runs.find((entry) => entry.schemaVersion === "company-research-report-v1");
  const occupied = research.state.globalActiveRun !== null;
  const otherActive = occupied && (research.state.globalActiveRun!.itemId !== itemId || research.state.globalActiveRun!.companyId !== companyId);
  const summary = research.state.runs.find((entry) => entry.id === research.selectedRunId);
  const selectionKey = `${itemId}:${companyId}:${research.selectedRunId ?? ""}`;
  const currentSelectionKey = useRef(selectionKey);
  currentSelectionKey.current = selectionKey;
  const status = active?.run.status ?? summary?.status;
  const canRetry = researchRetryMode(summary) !== "unavailable";
  const canRetryStructuring = summary?.status === "structure_failed";
  const reportSearchStatus = run?.searchStatus ?? summary?.searchStatus ?? active?.run.searchStatus ?? "unknown";
  const modalOpen = newReportModalOpen || retryModalOpen;
  const displayedError = research.error;
  const rawText = run?.schemaVersion === "company-research-report-v1"
    ? run.rawReportText ?? (active?.draftText || research.rawDraftText)
    : active?.draftText || research.rawDraftText;
  const canExport = !exporting
    && !research.detailLoading
    && summary !== undefined
    && run?.id === summary.id
    && hasPersistedReportBody(run);
  const availableRaw = hasPersistedReportBody(run);
  const availableStructured = run?.schemaVersion === "company-research-report-v1" && run.status === "completed" && run.structuredContent !== undefined;
  useEffect(() => {
    setExportFeedback(undefined);
    setExportChoiceOpen(false);
  }, [selectionKey]);
  useEffect(() => () => {
    exportSequence.current += 1;
    exportInFlight.current = false;
  }, []);
  const openExportChoice = () => {
    if (!canExport) return;
    setExportSelection(availableStructured ? { raw: false, structured: true } : { raw: true, structured: false });
    setExportChoiceOpen(true);
  };
  const exportSelected = async (selection: CompanyResearchWordExportSelection) => {
    const runId = research.selectedRunId;
    if (!canExport || !runId || exportInFlight.current || (!selection.raw && !selection.structured)) return;
    const key = selectionKey;
    const ticket = ++exportSequence.current;
    exportInFlight.current = true;
    setExportChoiceOpen(false);
    setExporting(true);
    setExportFeedback(undefined);
    try {
      const result = await api.companyResearch.exportWord(itemId, companyId, runId, selection);
      if (exportSequence.current !== ticket || currentSelectionKey.current !== key) return;
      setExportFeedback(result.status === "saved"
        ? { key, kind: "saved", message: "Word 报告已保存。" }
        : { key, kind: "cancelled", message: "已取消导出。" });
    } catch {
      if (exportSequence.current === ticket && currentSelectionKey.current === key) {
        setExportFeedback({ key, kind: "error", message: "导出 Word 失败，请重试。" });
      }
    } finally {
      if (exportSequence.current === ticket) {
        exportInFlight.current = false;
        setExporting(false);
      }
    }
  };
  const exportButton = <button type="button" disabled={!canExport} onClick={openExportChoice}>{exporting ? "导出中…" : "导出 Word"}</button>;
  const exportFeedbackControl = exportFeedback?.key === selectionKey && (exportFeedback.kind === "error"
    ? <span className="company-report-export-feedback error" role="alert" aria-label={exportFeedback.message}>{exportFeedback.message}</span>
    : <span className="company-report-export-feedback muted" role="status" aria-label={exportFeedback.message}>{exportFeedback.message}</span>);
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
      <div><h2 id="company-research-title">公司调研</h2><p className="muted">AI 调研结果仅供参考，重要事实仍需人工核验。一次成功调用不保证证据充分。</p></div>
      {!active && <div className="company-research-actions">
        {canRetryStructuring
          ? <button disabled={research.loading || research.pending || occupied} onClick={() => void research.retryStructuring().catch(() => {})}>重新整理</button>
          : canRetry && <button disabled={research.loading || research.pending || occupied} onClick={() => setRetryModalOpen(true)}>重新尝试</button>}
        <button className="primary-button" disabled={research.loading || research.pending || occupied} onClick={() => setNewReportModalOpen(true)}>{research.state.runs.length ? "新的调研" : "开始调研"}</button>
      </div>}
    </div>
    {otherActive && <p role="status">其他公司正在调研，请稍后再试。</p>}
    {displayedError && !modalOpen && <p className="error" role="alert">{displayedError.message} {(displayedError.kind === "state-load" || displayedError.kind === "detail-load")
      ? <button onClick={research.reload}>重新加载</button>
      : displayedError.kind === "configuration" && onOpenSettings
        ? <button onClick={() => onOpenSettings(displayedError.settingsModule)}>前往设置</button>
        : null}</p>}
    {research.loading ? <p className="muted">加载调研状态…</p> : <>
      {active && <div className="company-research-status" role="status">
        <div><div className="company-research-status-line"><span className="company-research-spinner" aria-hidden="true" /><strong>{active.run.status === "researching" ? "正在联网调研…" : "正在整理结构化报告…"}</strong>
          {active.latestActivity && <span className="company-research-activity">{activityLabel(active.latestActivity)}</span>}</div>
          <span>{research.elapsedLabel}</span></div>
        <button type="button" disabled>导出 Word</button>
        <button disabled={research.pending} onClick={() => void research.cancel()}>取消调研</button>
      </div>}
      {!active && research.state.runs.length > 0 && <div className="company-report-version-controls">
        <label className="company-report-version">报告版本<select value={research.selectedRunId} onChange={(event) => research.selectRun(event.target.value)}>
          {research.state.runs.map((entry) => <option key={entry.id} value={entry.id}>{runLabel(entry)}</option>)}
        </select></label>
        <button type="button" className="company-report-delete" disabled={research.pending || occupied || !summary} onClick={() => { setDeleteError(undefined); setDeleteConfirmationOpen(true); }}>删除</button>
      </div>}
      {status && status !== "researching" && (reportSearchStatus === "none"
        ? <p className="company-research-search-warning" role="alert">本次报告未成功完成联网搜索，内容可能主要来自模型已有知识，时效性与来源尚未核验。请检查 Search 配置后重新尝试。</p>
        : reportSearchStatus === "unknown"
          ? <p className="company-research-search-unknown" role="status">此历史报告未记录联网搜索状态，无法确认是否成功联网。</p>
          : null)}
      {status === "research_failed" && <div className="company-research-status"><p role="status">{research.selectedFailureMessage ?? "调研未完成，请稍后重试"}</p></div>}
      {status === "structure_failed" && <div className="company-research-status"><p role="status">整理失败，请重试</p></div>}
      {active?.run.status === "researching" ? <div className="company-report-text" aria-live="polite">{active.draftText ? <MarkdownMessage content={active.draftText} /> : <span className="muted">报告生成后将在这里显示。</span>}</div>
        : status === "research_failed" ? (run?.schemaVersion === "company-research-report-v1" ? <ResearchReportContext run={run} /> : research.detailLoading ? <p className="muted">加载调研报告…</p> : null)
        : run?.schemaVersion === "legacy-freeform-v1" ? <div>
          <div role="group" aria-label="报告视图与导出" className="research-tabs-toolbar"><div className="research-tabs"><span className="research-tab-label">原始调研报告</span></div>{exportButton}{exportFeedbackControl}</div>
          <h3>旧版原始报告</h3>
          <dl className="research-context"><div><dt>调研时间范围</dt><dd>{run.timeScope}</dd></div>{run.customRequirements && <div><dt>补充要求</dt><dd>{run.customRequirements}</dd></div>}</dl>
          <div className="company-report-text"><MarkdownMessage content={run.reportText} /></div>
        </div>
        : run?.schemaVersion === "company-research-report-v1" || active?.run.status === "structuring" || (status === "structure_failed" && rawText) ? <ReportTabs key={`${research.selectedRunId}:${status}:${run?.status ?? "loading"}`} run={run?.schemaVersion === "company-research-report-v1" ? run : undefined} rawText={rawText} exportControl={<>{exportButton}{exportFeedbackControl}</>} />
        : research.detailLoading ? <p className="muted">加载调研报告…</p>
        : research.state.runs.length === 0 ? <p className="muted company-research-empty">还没有调研报告。</p> : null}
      {!active && research.state.runs.length > 0 && (!run || status === "research_failed") && <div role="group" aria-label="报告视图与导出" className="research-tabs-toolbar company-report-export-fallback"><button type="button" disabled>导出 Word</button></div>}
    </>}
    {newReportModalOpen && <CompanyResearchModal {...context} {...(latest?.schemaVersion === "company-research-report-v1" ? { initial: latest } : {})} active={panelActive} disabled={occupied} onClose={() => setNewReportModalOpen(false)} onStart={research.start} {...(onOpenSettings ? { onOpenSettings } : {})} />}
    {retryModalOpen && summary?.schemaVersion === "company-research-report-v1" && <CompanyResearchModal {...context} mode="retry" initial={summary} active={panelActive} disabled={occupied} onClose={() => setRetryModalOpen(false)} onStart={research.retry} {...(onOpenSettings ? { onOpenSettings } : {})} />}
    {exportChoiceOpen && <WordExportChoiceModal
      availableRaw={availableRaw}
      availableStructured={availableStructured}
      selection={exportSelection}
      busy={exporting}
      onChange={setExportSelection}
      onClose={() => setExportChoiceOpen(false)}
      onConfirm={() => void exportSelected({ ...exportSelection })}
    />}
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
