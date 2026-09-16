import { useState, type FormEvent } from "react";
import { COMPANY_RESEARCH_TEMPLATES, RESEARCH_DIRECTIONS, type ResearchDirection, type StartCompanyResearchInput } from "@deepfield/contracts";
import { Modal } from "./Modal.js";
import { researchActionError, type ResearchActionErrorPresentation } from "./research-error-presentation.js";

export interface ResearchContextProps {
  readonly topicName: string;
  readonly topicScope?: string;
  readonly companyName: string;
  readonly companyNote?: string;
}
export interface CompanyResearchModalProps extends ResearchContextProps {
  initial?: StartCompanyResearchInput;
  mode?: "start" | "retry";
  disabled?: boolean;
  active?: boolean;
  onClose(): void;
  onStart(input: StartCompanyResearchInput): Promise<void>;
  onOpenSettings?(module: "llm" | "search"): void;
}
function localToday(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function validDate(value: string, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > today) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function CompanyResearchModal({ initial, mode = "start", disabled, active = true, topicName, topicScope, companyName, companyNote, onClose, onStart, onOpenSettings }: CompanyResearchModalProps) {
  const today = localToday();
  const [direction, setDirection] = useState<ResearchDirection>(initial && RESEARCH_DIRECTIONS.includes(initial.direction) ? initial.direction : "product_and_technology");
  const [focusScope, setFocusScope] = useState(initial?.focusScope && initial.focusScope.length <= 1000 ? initial.focusScope : "");
  const [asOfDate, setAsOfDate] = useState(initial && validDate(initial.asOfDate, today) ? initial.asOfDate : today);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ResearchActionErrorPresentation>();
  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting || disabled) return;
    if (!RESEARCH_DIRECTIONS.includes(direction) || !validDate(asOfDate, localToday()) || focusScope.length > 1000) {
      setError({ message: "请选择研究方向、有效的截至日期（不晚于今天），关注范围最多 1000 字。" });
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await onStart({ direction, asOfDate, ...(focusScope.trim() ? { focusScope: focusScope.trim() } : {}) });
      onClose();
    } catch (error) {
      setError(researchActionError(error, mode));
      setSubmitting(false);
    }
  };
  const submitLabel = mode === "retry" ? "重新尝试" : "开始调研";
  return <Modal title={mode === "retry" ? "重新尝试调研" : "公司调研"} active={active} onClose={submitting ? () => undefined : onClose}>
    <form className="modal-form" onSubmit={handleSubmit}>
      <dl className="research-context">
        <div><dt>研究主题</dt><dd>{topicName}</dd></div>
        {topicScope && <div><dt>研究范围</dt><dd>{topicScope}</dd></div>}
        <div><dt>公司</dt><dd>{companyName}</dd></div>
        {companyNote && <div><dt>候选备注</dt><dd>{companyNote}</dd></div>}
      </dl>
      {error && <p className="error" role="alert">{error.message} {error.settingsModule && onOpenSettings && <button type="button" onClick={() => onOpenSettings(error.settingsModule!)}>前往设置</button>}</p>}
      {disabled && <p className="muted">已有调研正在运行，请稍后再试。</p>}
      <label>研究方向<select required value={direction} onChange={(event) => setDirection(event.target.value as ResearchDirection)}>
        {RESEARCH_DIRECTIONS.map((value) => <option key={value} value={value}>{COMPANY_RESEARCH_TEMPLATES[value].title}</option>)}
      </select></label>
      <label>关注范围（可选）<textarea value={focusScope} maxLength={1000} rows={4} onChange={(event) => setFocusScope(event.target.value)} /></label>
      <label>截至日期<input type="date" value={asOfDate} max={today} required onChange={(event) => setAsOfDate(event.target.value)} /></label>
      <div className="modal-actions">
        <button type="button" disabled={submitting} onClick={onClose}>取消</button>
        <button className="primary-button" type="submit" disabled={submitting || disabled}>{submitting ? (mode === "retry" ? "正在重新尝试…" : "正在启动…") : submitLabel}</button>
      </div>
    </form>
  </Modal>;
}
