import { useState } from "react";
import type { InteractionRecord, RespondCommand, ChatCapabilityOperationCard, ChatCapabilityTaskCard } from "@deepfield/contracts";
import type { ViewRef, DraftRef } from "@deepfield/capability-sdk";

const terminalLabels: Record<string, string> = {
  answered: "已回答", cancelled: "已取消", invalidated: "内容已失效", executing: "执行中",
  submitted: "已提交", succeeded: "已完成", failed: "执行失败", uncertain: "结果待核实",
};

export function ChatInteractionCard({ interaction, respond, openEditor, operation, task, open }: {
  interaction: InteractionRecord;
  respond(command: RespondCommand): Promise<InteractionRecord>;
  openEditor?(): Promise<void>;
  operation?: ChatCapabilityOperationCard | undefined;
  task?: ChatCapabilityTaskCard | undefined;
  open?(target: ViewRef | DraftRef): Promise<void>;
}) {
  const [choice, setChoice] = useState("");
  const [freeText, setFreeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const payload = interaction.payload;
  const waiting = interaction.status === "waiting";
  const editing = interaction.status === "editing";
  const selectedLabel = payload.kind === "question" ? payload.options?.find(option => option.id === choice)?.label : undefined;
  const displayResult = interaction.resultSummary && !/^[\s]*[\[{]/.test(interaction.resultSummary) ? interaction.resultSummary : undefined;
  const presentation = task?.snapshot.presentation ?? operation?.presentation;
  // Immediate interaction receipts may include recovery guidance absent from package copy.
  // Once a task is running, its live presentation supersedes the original submission receipt.
  const resultText = task ? presentation?.text ?? displayResult : displayResult ?? presentation?.text;
  const taskLabels: Record<string, string> = { queued: "排队中", running: "进行中", paused: "已暂停", succeeded: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
  const decide = (response: RespondCommand["response"]) => {
    if (busy) return;
    setBusy(true); setError(undefined);
    void respond({ interactionId: interaction.id, expectedRevision: interaction.revision, response })
      .catch(() => setError("内容已更新或操作失败，请核对后重试。"))
      .finally(() => setBusy(false));
  };
  return <article className={`chat-interaction-card ${waiting || editing ? "" : "compact"}`} aria-label={payload.kind === "question" ? "待回答问题" : "操作确认"}>
    {waiting || editing ? <>
      <p className="chat-interaction-prompt">{payload.kind === "question" ? payload.question : payload.summary}</p>
      {payload.kind === "question" ? <>
        {payload.options?.map(option => <label key={option.id} className={`chat-interaction-option ${choice === option.id ? "selected" : ""}`}>
          <input type="radio" name={`interaction-${interaction.id}`} checked={choice === option.id} disabled={!waiting || busy}
            onChange={() => { setChoice(option.id); setFreeText(""); }} />{option.label}
        </label>)}
        {(payload.allowFreeText !== false || !payload.options?.length) && <textarea aria-label="回答内容" value={freeText}
          disabled={!waiting || busy} onChange={event => { setFreeText(event.target.value); setChoice(""); }} />}
        <div className="capability-card-actions"><button disabled={!waiting || busy || (!choice && !freeText.trim())}
          onClick={() => decide({ kind: "answer", text: selectedLabel || freeText.trim() })}>提交回答</button>
          <button disabled={busy} onClick={() => decide({ kind: "decision", decision: "cancel" })}>取消</button></div>
      </> : <>
        {openEditor && payload.operation.draftRef && <button className="capability-card-link" disabled={busy}
          onClick={() => { setError(undefined); void openEditor().catch(() => setError("打开表单失败。")); }}>查看或编辑表单</button>}
        {editing && <p role="status">正在同步编辑，请稍候…</p>}
        <div className="capability-card-actions">
          <button disabled={!waiting || busy} onClick={() => decide({ kind: "decision", decision: "approve" })}>确认执行</button>
          <button disabled={busy} onClick={() => decide({ kind: "decision", decision: "cancel" })}>取消</button>
        </div>
      </>}
    </> : <><span className="capability-card-status">{task ? taskLabels[task.snapshot.status] : terminalLabels[interaction.status]} · </span>
      <span>{payload.kind === "question" ? interaction.answer ?? payload.question : resultText ?? payload.summary}</span>
      {presentation?.target && open && <button className="capability-card-link" onClick={() => {
        void open(presentation.target!).catch(() => setError("打开页面失败。"));
      }}>{presentation.linkLabel ?? "查看"}</button>}
      {task?.snapshot.error && <p role="alert">{task.snapshot.error.message}</p>}
      {task?.analysisState === "pending" && <span>等待当前对话空闲后分析</span>}
      {task?.analysisState === "interrupted" && <span>分析已中断，可在对话中重新要求</span>}
      {interaction.failureReason && <p role="alert">操作未完成，请检查状态后重试。</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </article>;
}
