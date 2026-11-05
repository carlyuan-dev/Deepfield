import type { TracePort, TraceSpan } from "@deepfield/base/trace";
import type { CompanyResearchBatchState } from "../contracts/index.js";
import type { ResearchReceipt } from "../actions/task-artifact-adapter.js";

/** Observes committed queue snapshots; never participates in its transaction. */
export class ResearchQueueTrace {
  private readonly spans = new Map<string, TraceSpan>();
  private readonly states = new Map<string, string>();
  constructor(private readonly port: TracePort, private readonly receipt: (id: string) => string | undefined) {}
  scope(id?: string) { return id ? this.spans.get(id)?.context : undefined; }
  observe(state: CompanyResearchBatchState): void {
    try {
      const parents = new Map<string, string[]>();
      for (const entry of state.entries) {
        if (!entry.entryId) continue;
        const json = this.receipt(entry.entryId);
        const receipt = json ? JSON.parse(json) as ResearchReceipt : undefined;
        let parent = this.port.capture();
        if (receipt?.parentTaskId) {
          const ids = parents.get(receipt.parentTaskId) ?? []; ids.push(entry.entryId); parents.set(receipt.parentTaskId, ids);
          let aggregate = this.spans.get(receipt.parentTaskId);
          const previousStatus = this.states.get(receipt.parentTaskId);
          const reopened = aggregate && previousStatus && ["succeeded", "failed", "cancelled"].includes(previousStatus)
            && (entry.status === "pending" || entry.status === "running");
          if (!aggregate || reopened) {
            const previous = aggregate?.context;
            const parentJson = this.receipt(receipt.parentTaskId);
            const parentReceipt = parentJson ? JSON.parse(parentJson) as ResearchReceipt : undefined;
            aggregate = this.port.start("task", previous?.requestId ?? parent?.requestId ?? `task:${receipt.parentTaskId}`, { taskId: receipt.parentTaskId,
              ...(parentReceipt ? { invocationId: parentReceipt.invocationId } : {}) }, previous ?? parent ?? null);
            this.port.link(aggregate.context, [previous ?? (parentReceipt ? this.port.find({ kind: "invocation", id: parentReceipt.invocationId }) : undefined)]);
            this.spans.set(receipt.parentTaskId, aggregate);
            this.states.delete(receipt.parentTaskId);
          }
          parent = aggregate.context;
        }
        const status = entry.status === "completed" ? "succeeded" : entry.status === "failed" ? "failed" : entry.status === "cancelled" ? "cancelled"
          : state.status === "paused" ? "paused" : entry.status === "running" ? "running" : "queued";
        const previousStatus = this.states.get(entry.entryId);
        if (previousStatus && ["succeeded", "failed", "cancelled"].includes(previousStatus) && !["succeeded", "failed", "cancelled"].includes(status)) this.spans.delete(entry.entryId);
        let span = this.spans.get(entry.entryId);
        if (!span) {
          const previous = this.port.find({ kind: "task", id: entry.entryId });
          span = this.port.start("task", parent?.requestId ?? `task:${entry.entryId}`, { taskId: entry.entryId,
            ...(receipt ? { invocationId: receipt.invocationId } : {}), ...(entry.runId ? { runId: entry.runId } : {}) }, parent ?? null);
          if (previous || (receipt && !receipt.parentTaskId)) this.port.link(span.context, [previous ?? this.port.find({ kind: "invocation", id: receipt!.invocationId })]);
          this.spans.set(entry.entryId, span);
        }
        if (this.states.get(entry.entryId) === status) continue;
        this.states.set(entry.entryId, status);
        if (status === "succeeded" || status === "failed" || status === "cancelled") span.end(status); else span.state(status);
      }
      for (const [id, children] of parents) {
        const states = children.map(child => this.states.get(child));
        const terminal = states.every(value => value === "succeeded" || value === "failed" || value === "cancelled");
        const span = this.spans.get(id)!;
        const status = terminal ? states.includes("failed") ? "failed" : states.includes("cancelled") ? "cancelled" : "succeeded"
          : states.includes("paused") ? "paused" : states.includes("running") ? "running" : "queued";
        if (this.states.get(id) === status) continue;
        this.states.set(id, status);
        if (status === "failed" || status === "cancelled" || status === "succeeded") span.end(status);
        else span.state(status);
      }
      if (state.status === "completed" || state.status === "cancelled") { this.spans.clear(); this.states.clear(); }
    } catch { /* Trace metadata/storage failures never change a committed queue. */ }
  }
  dispose(): void { for (const span of this.spans.values()) span.end("interrupted", "process_exit"); this.spans.clear(); this.states.clear(); }
}
