import { useState } from "react";
import type { ChatAgentTask } from "@deepfield/contracts";
import { MarkdownMessage } from "./MarkdownMessage.js";

const labels: Record<string, string> = { queued: "等待中", running: "进行中", cancelling: "正在停止", completed: "已完成", failed: "失败", cancelled: "已停止", timed_out: "超时", interrupted: "已中断" };
export function AgentActivity({ tasks, onCancel }: { tasks: ChatAgentTask[]; onCancel?: (taskId: string) => Promise<void> }) {
  const [error, setError] = useState("");
  if (!tasks.length) return null;
  const complete = tasks.filter(task => task.status === "completed").length;
  const running = tasks.filter(task => ["queued", "running", "cancelling"].includes(task.status)).length;
  return <details className="agent-activity">
    <summary>协作任务 · {complete}/{tasks.length} 已完成{running > 0 ? ` · ${running} 项进行中` : ""}</summary>
    <div className="agent-activity-list">{tasks.map(task => <details key={task.taskId} className="agent-task">
      <summary><span>{task.title}</span><span className={`agent-task-state ${task.status}`}>{labels[task.status] ?? "已中断"}</span></summary>
      <p className="muted">{task.instruction}</p>
      {task.progress && <p className="muted">{task.progress}</p>}
      {!!task.activities?.length && <details className="agent-task-history"><summary>执行过程</summary><ol>
        {task.activities.map((activity, index) => <li key={index}>{activity}</li>)}
      </ol></details>}
      {task.result ? <MarkdownMessage content={task.result} /> : task.summary ? <p>{task.summary}</p> : null}
      {["failed", "timed_out", "interrupted"].includes(task.status) && <p className="muted">{task.status === "timed_out" ? "任务已超时，已保存的结果仍可使用。" : "任务未完成，可让主 Agent 根据已有结果继续处理。"}</p>}
      {onCancel && ["queued", "running"].includes(task.status) && <button type="button" className="agent-task-cancel" onClick={() => {
        setError(""); void onCancel(task.taskId).catch(() => setError("停止任务未完成，请重试。"));
      }}>停止此任务</button>}
    </details>)}</div>
    {error && <p role="alert">{error}</p>}
  </details>;
}
