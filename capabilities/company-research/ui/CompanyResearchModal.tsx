import { useState, type FormEvent } from "react";
import { RESEARCH_MODULE_GROUPS, normalizeResearchModuleIds, type ResearchModuleId, type StartCompanyResearchInput } from "../contracts/index.js";
import { Modal } from "../../../apps/desktop/src/renderer/components/Modal.js";
import { researchActionError, type ResearchActionErrorPresentation } from "./research-error-presentation.js";
import { useFormField, type FormControl } from "./form-control.js";

export interface ResearchContextProps {
  readonly topicName: string;
  readonly topicScope?: string;
  readonly companyName: string;
}
export interface CompanyResearchModalProps extends ResearchContextProps {
  control?: FormControl;
  initial?: StartCompanyResearchInput;
  mode?: "start" | "retry";
  disabled?: boolean;
  active?: boolean;
  onClose(): void;
  onStart(input: StartCompanyResearchInput): Promise<void>;
  onOpenSettings?(module: "llm" | "search"): void;
  title?: string;
  submitLabel?: string;
  submittingLabel?: string;
  closeOnSubmit?: boolean;
  cancelLabel?: string;
  onEdited?(): void;
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
export function CompanyResearchModal({ initial, control, mode = "start", disabled, active = true, topicName, topicScope, companyName, onClose, onStart, onOpenSettings, title, submitLabel: customSubmitLabel, submittingLabel, closeOnSubmit = true, cancelLabel = "取消", onEdited }: CompanyResearchModalProps) {
  const today = localToday();
  const [moduleIds, setModuleIds] = useFormField<ResearchModuleId[]>(control, "moduleIds", initial?.moduleIds ?? []);
  const [focusScope, setFocusScope] = useFormField(control, "focusScope", initial?.focusScope && initial.focusScope.length <= 1000 ? initial.focusScope : "");
  const [asOfDate, setAsOfDate] = useFormField(control, "asOfDate", initial && validDate(initial.asOfDate, today) ? initial.asOfDate : today);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ResearchActionErrorPresentation>();
  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting || disabled) return;
    if (moduleIds.length < 1 || moduleIds.length > 5 || !validDate(asOfDate, localToday()) || focusScope.length > 1000) {
      setError({ message: "请选择 1–5 个研究模块、有效的截至日期（不晚于今天），关注范围最多 1000 字。" });
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await control?.flush();
      await onStart({ moduleIds: normalizeResearchModuleIds(moduleIds), asOfDate, ...(focusScope.trim() ? { focusScope: focusScope.trim() } : {}) });
      if (closeOnSubmit) onClose();
      else setSubmitting(false);
    } catch (error) {
      setError(researchActionError(error, mode));
      setSubmitting(false);
    }
  };
  const submitLabel = customSubmitLabel ?? (mode === "retry" ? "重新尝试" : "开始调研");
  return <Modal title={title ?? (mode === "retry" ? "重新尝试调研" : "公司调研")} active={active} onClose={submitting ? () => undefined : onClose}>
    <form className="modal-form" onSubmit={handleSubmit}>
      <dl className="research-context">
        <div><dt>研究主题</dt><dd>{topicName}</dd></div>
        {topicScope && <div><dt>研究范围</dt><dd>{topicScope}</dd></div>}
        <div><dt>公司</dt><dd>{companyName}</dd></div>
      </dl>
      {error && <p className="error" role="alert">{error.message} {error.settingsModule && onOpenSettings && <button type="button" onClick={() => onOpenSettings(error.settingsModule!)}>前往设置</button>}</p>}
      {disabled && <p className="muted">已有调研正在运行，请稍后再试。</p>}
      <fieldset className="research-module-picker">
        <legend>研究模块（选择 1–5 个）</legend>
        <p className="muted" role="status">{moduleIds.length >= 5 ? "已选 5 个；取消一个后可选择其他模块。" : `已选 ${moduleIds.length} 个，可跨组选择。`}</p>
        {RESEARCH_MODULE_GROUPS.map(group => <section key={group.groupId} className="research-module-group" aria-label={group.title}>
          <h4>{group.title}</h4>
          <div>{group.modules.map(module => <label key={module.sectionId} className="research-module-option" title={module.coreQuestion}>
            <input type="checkbox" checked={moduleIds.includes(module.sectionId)} disabled={submitting || (!moduleIds.includes(module.sectionId) && moduleIds.length >= 5)} onChange={event => {
              onEdited?.();
              const checked = event.target.checked;
              setModuleIds(current => {
                const next = checked ? [...current, module.sectionId] : current.filter(id => id !== module.sectionId);
                return next.length ? normalizeResearchModuleIds(next) : [];
              });
            }} />
            <span>{module.title}</span>
          </label>)}</div>
        </section>)}
      </fieldset>
      <label>关注范围（可选）<textarea value={focusScope} maxLength={1000} rows={4} onChange={(event) => { onEdited?.(); setFocusScope(event.target.value); }} /></label>
      <label>截至日期<input type="date" value={asOfDate} max={today} required onChange={(event) => { onEdited?.(); setAsOfDate(event.target.value); }} /></label>
      <div className="modal-actions">
        <button type="button" disabled={submitting} onClick={onClose}>{cancelLabel}</button>
        <button className="primary-button" type="submit" disabled={submitting || disabled || moduleIds.length < 1 || moduleIds.length > 5}>{submitting ? (submittingLabel ?? (mode === "retry" ? "正在重新尝试…" : "正在启动…")) : submitLabel}</button>
      </div>
    </form>
  </Modal>;
}
