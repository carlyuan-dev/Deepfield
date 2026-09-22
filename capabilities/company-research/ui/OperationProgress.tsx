import { useRef, useState } from "react";
import { toPublicError, type PublicAppError } from "@deepfield/contracts";
import { type CompanyProfileProgress, type CompanyResearchBatchState } from "../contracts/index.js";
import { configurationErrorText } from "../../../apps/desktop/src/renderer/features/settings/error-presentation.js";
import { researchActionError } from "./research-error-presentation.js";

interface Props {
  batch: CompanyResearchBatchState | null;
  profile: CompanyProfileProgress | null;
  onCancel(batchId: string): Promise<void>;
  onResume(batchId: string): Promise<void>;
  onOpenSettings?(module: "llm" | "search"): void;
}
function settingsTarget(issue: PublicAppError | undefined): "llm" | "search" | undefined {
  if (!issue || (issue.category !== "configuration" && issue.code !== "EXTERNAL.AUTHENTICATION_FAILED")) return undefined;
  return issue.context?.service ?? "llm";
}
function pausedCause(issue: PublicAppError | undefined): string {
  if (!issue) return "应用重新启动后已暂停，请确认设置后继续调研。";
  return configurationErrorText(issue, "research") ?? "调研队列遇到问题并已暂停，请检查后继续。";
}
export function OperationProgress({ batch: batchState, profile, onCancel, onResume, onOpenSettings }: Props) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const busyRef = useRef(false);
  const act = async (work: () => Promise<void>): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setActionError(undefined);
    try { await work(); }
    catch (reason) { setActionError(researchActionError(toPublicError(reason), "start").message); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const profileIsCurrent = profile && profile.status !== "idle";
  const batchIsTerminal = batchState && ["completed", "cancelled"].includes(batchState.status);
  const batch = profileIsCurrent && batchIsTerminal ? null : batchState;
  if (batch) {
    const active = batch.status === "running" || batch.status === "waiting_profile" || batch.status === "cancelling";
    const terminal = batch.status === "completed" || batch.status === "cancelled";
    const label = batch.status === "waiting_profile" ? "等待当前公司资料补全完成" : batch.status === "paused" ? "调研队列已暂停" : batch.status === "completed" ? "调研队列已完成" : batch.status === "cancelled" ? "调研队列已取消" : "正在进行公司调研";
    const target = settingsTarget(batch.issue);
    return <div className="operation-progress" aria-live="polite">
      <div className="operation-progress-summary"><span className={batch.status === "running" ? "operation-progress-active" : undefined}>{label}</span>{batch.status === "paused" && <small>{pausedCause(batch.issue)}</small>}{terminal && <small>成功 {batch.succeeded} · 失败 {batch.failed}</small>}{!terminal && batch.failed > 0 && <small>失败 {batch.failed}</small>}</div>
      {!terminal && <div className="operation-progress-bar" role="progressbar" aria-label="调研队列进度" aria-valuemin={0} aria-valuemax={batch.total} aria-valuenow={batch.processed}><span style={{ width: `${batch.total ? Math.min(100, batch.processed / batch.total * 100) : 0}%` }} /><strong>{batch.processed}/{batch.total}</strong></div>}
      {active && <span className="company-profile-spinner" role="status" aria-label="调研队列进行中" />}
      {batch.status === "paused" && <><button className="operation-link" disabled={busy} onClick={() => void act(() => onResume(batch.batchId))}>继续调研</button>{target && onOpenSettings && <button className="operation-link" onClick={() => onOpenSettings(target)}>前往设置</button>}</>}
      {!terminal && <button className="operation-link" disabled={busy || (batch.status === "cancelling" && !actionError)} onClick={() => void act(() => onCancel(batch.batchId))}>取消整个调研队列</button>}
      {actionError && <span className="operation-error" role="alert">{actionError}</span>}
    </div>;
  }
  if (profile && profile.status !== "idle") {
    const active = profile.status === "running" || profile.status === "waiting";
    const terminal = profile.status === "completed";
    const label = profile.status === "paused" ? "公司资料补全已暂停" : profile.status === "completed" ? "公司资料补全已完成" : "正在自动补全公司信息";
    return <div className="operation-progress"><div className="operation-progress-summary"><span className={profile.status === "running" ? "operation-progress-active" : undefined}>{label}</span>{terminal ? <small>成功 {profile.processed - profile.failed} · 失败 {profile.failed}</small> : profile.failed > 0 && <small>失败 {profile.failed}</small>}</div>{!terminal && <div className="operation-progress-bar" role="progressbar" aria-label="公司资料补全进度" aria-valuemin={0} aria-valuemax={profile.total} aria-valuenow={profile.processed}><span style={{ width: `${profile.total ? profile.processed / profile.total * 100 : 0}%` }} /><strong>{profile.processed}/{profile.total}</strong></div>}{active && <span className="company-profile-spinner" role="status" aria-label="公司资料补全进行中" />}</div>;
  }
  return null;
}
