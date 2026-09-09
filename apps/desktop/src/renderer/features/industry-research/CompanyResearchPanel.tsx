import { useState } from "react";
import type { DesktopApi, ResearchRun, StartCompanyResearchInput } from "@deepfield/contracts";
import { LinkifiedText } from "../../components/LinkifiedText.js";
import { CompanyResearchModal } from "./CompanyResearchModal.js";
import { useCompanyResearch } from "./use-company-research.js";

export interface CompanyResearchPanelProps {
  api: DesktopApi;
  itemId: string;
  companyId: string;
}

function runLabel(run: ResearchRun): string {
  const completedAt = run.completedAt === undefined ? "完成时间未知" : new Intl.DateTimeFormat(
    "zh-CN",
    { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" },
  ).format(new Date(run.completedAt));
  return `${completedAt} · ${run.timeScope}`;
}

export function CompanyResearchPanel({ api, itemId, companyId }: CompanyResearchPanelProps) {
  const research = useCompanyResearch(api, itemId, companyId);
  const [modalOpen, setModalOpen] = useState(false);
  const latest = research.state.completed[0];
  const initial: StartCompanyResearchInput | undefined = latest === undefined
    ? undefined
    : {
        timeScope: latest.timeScope,
        ...(latest.customRequirements !== undefined
          ? { customRequirements: latest.customRequirements }
          : {}),
      };

  return (
    <section className="company-research-panel" aria-labelledby="company-research-title">
      <div className="company-research-heading">
        <div>
          <h2 id="company-research-title">公司调研</h2>
          <p className="muted">联网生成初步调研报告，重要信息仍需人工核实。</p>
        </div>
        {research.state.active === undefined && (
          <button className="primary-button" onClick={() => setModalOpen(true)}>
            {research.state.completed.length === 0 ? "开始调研" : "重新调研"}
          </button>
        )}
      </div>

      {research.error !== undefined && <p className="error" role="alert">{research.error}</p>}
      {research.loading ? (
        <p className="muted">加载调研状态…</p>
      ) : research.state.active !== undefined ? (
        <div className="company-research-active" aria-live="polite">
          <div className="company-research-status">
            <div><strong>正在联网调研…</strong><span>{research.elapsedLabel}</span></div>
            <button onClick={() => void research.cancel()}>取消调研</button>
          </div>
          <div className="company-report-text">
            {research.state.active.draftText.length > 0
              ? <LinkifiedText text={research.state.active.draftText} />
              : <span className="muted">报告生成后将在这里显示。</span>}
          </div>
        </div>
      ) : research.selectedRun !== undefined ? (
        <div className="company-research-completed">
          <label className="company-report-version">
            报告版本
            <select
              value={research.selectedRunId}
              onChange={(event) => research.selectRun(event.target.value)}
            >
              {research.state.completed.map((run) => (
                <option key={run.id} value={run.id}>{runLabel(run)}</option>
              ))}
            </select>
          </label>
          <div className="company-report-text">
            <LinkifiedText text={research.selectedRun.reportText ?? ""} />
          </div>
        </div>
      ) : (
        <p className="muted company-research-empty">还没有调研报告。</p>
      )}

      {modalOpen && (
        <CompanyResearchModal
          {...(initial !== undefined ? { initial } : {})}
          onClose={() => setModalOpen(false)}
          onStart={research.start}
        />
      )}
    </section>
  );
}
