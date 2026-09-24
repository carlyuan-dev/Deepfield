import { useState } from "react";
import type { ChatCapabilityConfirmation, ChatCapabilityOperationCard, ChatCapabilityTaskCard } from "@deepfield/contracts";
import type { ViewRef, DraftRef } from "@deepfield/capability-sdk";

function confirmationCopy(value: unknown): { title: string; fields: Array<{ label: string; value: string }> } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as { title?: unknown; fields?: unknown };
  if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 120 || !Array.isArray(item.fields) || item.fields.length > 12) return undefined;
  const fields: Array<{ label: string; value: string }> = [];
  for (const field of item.fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) return undefined;
    const candidate = field as { label?: unknown; value?: unknown };
    if (typeof candidate.label !== "string" || !candidate.label.trim() || candidate.label.length > 60
      || typeof candidate.value !== "string" || !candidate.value.trim() || candidate.value.length > 4000) return undefined;
    fields.push({ label: candidate.label, value: candidate.value });
  }
  return { title: item.title, fields };
}

const taskStatus: Record<ChatCapabilityTaskCard["snapshot"]["status"], string> = {
  queued: "排队中", running: "进行中", paused: "已暂停", succeeded: "已完成",
  failed: "失败", cancelled: "已取消", interrupted: "已中断",
};
const operationStatus: Record<ChatCapabilityOperationCard["status"], string> = {
  awaiting_confirmation: "待确认", completed: "已完成", failed: "失败", cancelled: "已取消",
  interrupted: "已中断", uncertain: "结果待核实",
};

export function CapabilityChatCards({ tasks, confirmations, operations, approve, dismiss, open }: {
  tasks: ChatCapabilityTaskCard[];
  confirmations: ChatCapabilityConfirmation[];
  operations: ChatCapabilityOperationCard[];
  approve(ref: string, analyzeAfter: boolean): Promise<void>;
  dismiss(ref: string): Promise<void>;
  open(target: ViewRef | DraftRef): Promise<void>;
}) {
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const visibleTasks = tasks.filter(card => card.snapshot.presentation);
  if (!visibleTasks.length && !confirmations.length && !operations.length) return null;
  const link = (target: ViewRef | DraftRef | undefined, label?: string) => target &&
    <button className="capability-card-link" onClick={() => { void open(target).catch(() => setError("打开页面失败。")); }}>{label ?? "查看"}</button>;
  return <section className="capability-chat-cards" aria-label="操作状态与确认">
    {error && <p role="alert">{error}</p>}
    {confirmations.map(item => {
      const copy = confirmationCopy(item.inputSummary);
      return <article key={item.confirmationRef} className="capability-chat-card">
        <h3>操作确认 · {copy?.title ?? "确认内容不可用"}</h3>
        {item.presentation && <p>{item.presentation.text}</p>}
        {copy?.fields.map((field, index) => <p key={index}><span>{field.label}：</span>{field.value}</p>)}
        {!copy && <p role="alert">无法安全展示确认内容，请重新发起操作。</p>}
        {link(item.presentation?.target, item.presentation?.linkLabel)}
        <div className="capability-card-actions">
          <button disabled={busy !== undefined || !copy} onClick={() => {
            setBusy(item.confirmationRef); setError(undefined);
            void approve(item.confirmationRef, item.analyzeAfter).catch(() => setError("确认失败，请检查操作状态。"))
              .finally(() => setBusy(undefined));
          }}>确认执行</button>
          <button disabled={busy !== undefined} onClick={() => {
            setBusy(item.confirmationRef); setError(undefined);
            void dismiss(item.confirmationRef).catch(() => setError("取消确认失败。"))
              .finally(() => setBusy(undefined));
          }}>取消</button>
        </div>
      </article>;
    })}
    {operations.map(card => <article key={card.invocationId} className="capability-chat-card compact">
      <span className="capability-card-status">{operationStatus[card.status]} · </span>
      <span>{card.presentation?.text ?? card.title}</span>
      {link(card.presentation?.target, card.presentation?.linkLabel)}
    </article>)}
    {visibleTasks.map(card => <article key={`${card.snapshot.taskRef.capabilityId}/${card.snapshot.taskRef.taskId}`} className="capability-chat-card compact">
      <span className="capability-card-status">{taskStatus[card.snapshot.status]} · </span>
      <span>{card.snapshot.presentation!.text}</span>
      {card.snapshot.error && <p role="alert">{card.snapshot.error.message}</p>}
      {link(card.snapshot.presentation?.target, card.snapshot.presentation?.linkLabel)}
      {card.analysisState === "pending" && <span>等待当前对话空闲后分析</span>}
      {card.analysisState === "interrupted" && <span>分析已中断，可在对话中重新要求</span>}
    </article>)}
  </section>;
}
