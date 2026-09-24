import type { ArtifactRef, ReadSlice, TaskSnapshot, TaskStatus, OperationPresentation, ViewRef } from "@deepfield/capability-sdk";
import type { CompanyResearchBatchService } from "../application/company-research-batch-service.js";
import type { CompanyResearchService } from "../application/company-research-service.js";
import type { CompanyResearchBatchState, ResearchRun } from "../contracts/index.js";
import { CAPABILITY_ID, protocolError, revision, type ProtocolStore } from "./drafts.js";
import { getCompanyResearchTemplate, RESEARCH_DIRECTIONS, type ResearchDirection } from "../contracts/index.js";
export interface ResearchReceipt { invocationId: string; itemId: string; companyId: string; runId?: string; parentTaskId?: string; entryIds?: string[]; topicName?: string; companyName?: string; direction?: string; asOfDate?: string; snapshot: TaskSnapshot }
export function artifactRef(run: ResearchRun): ArtifactRef {
  return { capabilityId: CAPABILITY_ID, artifactId: Buffer.from(JSON.stringify([run.itemId, run.companyId, run.id])).toString("base64url"), revision: revision(run) };
}
export function artifactTarget(id: string): [string, string, string] {
  try {
    if (id.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error();
    const target: unknown = JSON.parse(Buffer.from(id, "base64url").toString());
    if (!Array.isArray(target) || target.length !== 3 || target.some(value => typeof value !== "string" || !value || value.length > 200)) throw new Error();
    return target as [string, string, string];
  } catch { throw protocolError("not_found"); }
}
const terminal = (status: TaskStatus) => ["succeeded", "failed", "cancelled"].includes(status);
export class TaskArtifactAdapter {
  private readonly listeners = new Set<(snapshot: TaskSnapshot) => void>();
  constructor(private readonly store: ProtocolStore, private readonly batch: CompanyResearchBatchService, private readonly research: CompanyResearchService) {}
  persist(state: CompanyResearchBatchState): void {
    const now = new Date().toISOString();
    const parents = new Set<string>();
    for (const entry of state.entries) {
      if (!entry.entryId) continue;
      const data = this.store.getTask(entry.entryId); if (!data) continue;
      const receipt = JSON.parse(data) as ResearchReceipt;
      if (receipt.parentTaskId) parents.add(receipt.parentTaskId);
      if (entry.runId) receipt.runId = entry.runId;
      const status: TaskStatus = entry.status === "completed" ? "succeeded" : entry.status === "failed" ? "failed" : entry.status === "cancelled" ? "cancelled"
        : state.status === "paused" ? "paused" : entry.status === "running" ? "running" : "queued";
      if (!terminal(status)) delete receipt.snapshot.finishedAt;
      receipt.snapshot = { ...receipt.snapshot, status, updatedAt: now, cancellable: !terminal(status), ...(entry.stage ? { phase: entry.stage } : {}),
        ...(terminal(status) ? { finishedAt: receipt.snapshot.finishedAt ?? now } : {}),
        ...(entry.interrupted ? { warnings: ["调研因应用退出或服务中断而暂停，需要人工恢复。"] } : entry.issue ? { warnings: [entry.issue.code] } : {}) };
      this.store.saveTask(entry.entryId, receipt.invocationId, JSON.stringify(receipt), receipt.snapshot.finishedAt);
      try { const snapshot = this.snapshot(entry.entryId); for (const listener of this.listeners) { try { listener(snapshot); } catch { /* observer isolation */ } } } catch { /* receipt remains authoritative */ }
    }
    for (const parentId of parents) {
      const data = this.store.getTask(parentId); if (!data) continue;
      const receipt = JSON.parse(data) as ResearchReceipt;
      const aggregate = this.aggregate(receipt, now);
      receipt.snapshot = aggregate;
      this.store.saveTask(parentId, receipt.invocationId, JSON.stringify(receipt), aggregate.finishedAt);
      for (const listener of this.listeners) { try { listener(this.snapshot(parentId)); } catch { /* observer isolation */ } }
    }
    this.store.prune(new Date(Date.now() - 30 * 86400_000).toISOString());
  }
  subscribe(listener: (snapshot: TaskSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  find(invocationId: string): TaskSnapshot | undefined { const data = this.store.findTask(invocationId); return data ? this.snapshot((JSON.parse(data) as ResearchReceipt).snapshot.taskRef.taskId) : undefined; }
  snapshot(taskId: string): TaskSnapshot {
    const data = this.store.getTask(taskId); if (!data) throw protocolError("not_found");
    const receipt = JSON.parse(data) as ResearchReceipt;
    if (receipt.snapshot.finishedAt && Date.parse(receipt.snapshot.finishedAt) < Date.now() - 30 * 86400_000) throw protocolError("expired");
    if (receipt.entryIds) return this.aggregate(receipt, receipt.snapshot.updatedAt ?? new Date().toISOString());
    let run: ResearchRun | undefined;
    try { run = receipt.runId ? this.research.getRun(receipt.itemId, receipt.companyId, receipt.runId) : undefined; }
    catch (error) { if ((error as { code?: string }).code !== "RESOURCE.NOT_FOUND") throw error; }
    return { ...receipt.snapshot, presentation: this.singlePresentation(receipt, run), ...(run ? { artifactRefs: [artifactRef(run)], viewRefs: [{ capabilityId: CAPABILITY_ID, viewId: "report", input: { itemId: run.itemId, companyId: run.companyId, runId: run.id, revision: artifactRef(run).revision } }], ...(run.schemaVersion === "company-research-report-v1" && run.status === "structure_failed" ? { warnings: ["结构化整理失败，原始调研报告仍可读取。"] } : {}) } : {}) };
  }
  async cancel(taskId: string): Promise<TaskSnapshot> {
    const data = this.store.getTask(taskId); if (!data) throw protocolError("not_found");
    const receipt = JSON.parse(data) as ResearchReceipt;
    if (receipt.entryIds) {
      for (const entryId of receipt.entryIds) if (this.snapshot(entryId).cancellable) await this.batch.cancelEntry(entryId);
    } else if (this.snapshot(taskId).cancellable) await this.batch.cancelEntry(taskId);
    return this.snapshot(taskId);
  }
  private aggregate(receipt: ResearchReceipt, now: string): TaskSnapshot {
    const children = receipt.entryIds!.map(id => this.snapshot(id));
    const statuses = children.map(child => child.status);
    const done = statuses.every(status => terminal(status));
    const status: TaskStatus = done ? statuses.includes("failed") ? "failed" : statuses.includes("cancelled") ? "cancelled" : "succeeded"
      : statuses.includes("paused") ? "paused" : statuses.includes("running") ? "running" : "queued";
    return { ...receipt.snapshot, status, updatedAt: now, cancellable: !done,
      progress: children.length ? statuses.filter(terminal).length / children.length : 1,
      ...(done ? { finishedAt: receipt.snapshot.finishedAt ?? now } : {}),
      artifactRefs: children.flatMap(child => child.artifactRefs ?? []), viewRefs: children.flatMap(child => child.viewRefs ?? []),
      warnings: children.flatMap(child => child.warnings ?? []),
      message: `本次提交 ${children.length} 家：完成 ${statuses.filter(s => s === "succeeded").length}，失败 ${statuses.filter(s => s === "failed").length}，取消 ${statuses.filter(s => s === "cancelled").length}。`,
      presentation: { text: `“${(receipt.topicName ?? "当前主题").slice(0, 80)}”的批量调研：${children.length} 家中完成 ${statuses.filter(s => s === "succeeded").length} 家，失败 ${statuses.filter(s => s === "failed").length} 家，取消 ${statuses.filter(s => s === "cancelled").length} 家。${done ? "本次提交已结束。" : status === "paused" ? "队列已暂停。" : "队列仍在处理。"}`, linkLabel: "查看调研队列", target: { capabilityId: CAPABILITY_ID, viewId: "companies", input: { itemId: receipt.itemId } } },
    };
  }
  private singlePresentation(receipt: ResearchReceipt, run?: ResearchRun): OperationPresentation {
    const name = receipt.companyName ?? (run?.schemaVersion === "company-research-report-v1" ? run.researchContext.companyName : "当前公司");
    const direction = receipt.direction && RESEARCH_DIRECTIONS.includes(receipt.direction as ResearchDirection) ? getCompanyResearchTemplate(receipt.direction as ResearchDirection).title : run?.schemaVersion === "company-research-report-v1" ? run.template.title : "公司";
    const status = receipt.snapshot.status;
    const text = status === "queued" ? `“${name}”的${direction}调研已排队。`
      : status === "running" ? `“${name}”的${direction}调研${receipt.snapshot.phase === "structure" ? "正在整理报告" : "正在收集资料"}。`
      : status === "paused" || status === "interrupted" ? `“${name}”的调研已暂停，需要恢复队列。`
      : status === "succeeded" ? `“${name}”的${direction}调研已完成，报告可查看。`
      : status === "cancelled" ? `“${name}”的调研已取消。`
      : run?.schemaVersion === "company-research-report-v1" && run.status === "structure_failed" ? `“${name}”的报告整理失败，已保存的原始报告仍可查看。` : `“${name}”的调研失败，可检查原因后重试。`;
    const reportTarget: ViewRef | undefined = run && status !== "cancelled" ? { capabilityId: CAPABILITY_ID, viewId: "report", input: { itemId: run.itemId, companyId: run.companyId, runId: run.id, revision: artifactRef(run).revision } } : undefined;
    return { text, linkLabel: reportTarget ? "查看调研报告" : "查看公司调研", target: reportTarget ?? { capabilityId: CAPABILITY_ID, viewId: "company", input: { itemId: receipt.itemId, companyId: receipt.companyId } } };
  }
  read(ref: ArtifactRef, request: { cursor?: string; section?: string }): ReadSlice {
    if (ref.capabilityId !== CAPABILITY_ID) throw protocolError("not_found");
    let run: ResearchRun | undefined;
    try { run = this.research.getRun(...artifactTarget(ref.artifactId)); }
    catch (error) { if ((error as { code?: string }).code !== "RESOURCE.NOT_FOUND") throw error; }
    if (!run) throw protocolError("not_found");
    const current = artifactRef(run); if (current.revision !== ref.revision) throw protocolError("revision_changed");
    const section = request.section ?? "summary";
    let data: unknown;
    if (section === "summary") data = { id: run.id, itemId: run.itemId, companyId: run.companyId, status: run.status, schemaVersion: run.schemaVersion,
      createdAt: run.createdAt, completedAt: run.completedAt ?? null, searchStatus: run.searchStatus ?? "unknown",
      qualityNotice: "AI 调研结果仅供参考，重要事实仍需人工核验。联网状态不能保证证据充分。",
      sections: run.schemaVersion === "legacy-freeform-v1" ? ["raw"] : ["raw", "structured", "evidence"],
      ...(run.schemaVersion === "company-research-report-v1" ? { title: `${run.researchContext.companyName} · ${run.template.title}`, rawCompletedAt: run.rawCompletedAt ?? null, direction: run.direction, asOfDate: run.asOfDate, failureStage: run.status === "structure_failed" ? "structure" : run.status === "research_failed" ? "raw" : null } : { title: "旧版原始调研报告" }) };
    else if (section === "raw") data = run.schemaVersion === "legacy-freeform-v1" ? run.reportText : run.rawReportText ?? "";
    else if (section === "structured") data = run.schemaVersion === "company-research-report-v1" ? run.structuredContent ?? null : null;
    else if (section === "evidence") data = run.schemaVersion === "company-research-report-v1" ? run.structuredContent?.sections.flatMap(s => s.facts.map(f => f.source)) ?? [] : [];
    else throw protocolError("not_found");
    const content = section === "raw" ? String(data) : JSON.stringify(data);
    let offset = 0;
    if (request.cursor) {
      try {
        if (request.cursor.length > 2000) throw new Error();
        const cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString());
        if (cursor.binding !== revision([ref, section]) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > content.length) throw new Error();
        offset = cursor.offset;
      } catch { throw protocolError("revision_changed"); }
    }
    // 6000 UTF-16 units bound even worst-case JSON escaping below 64 KiB.
    let end = Math.min(content.length, offset + 6000);
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
    const truncated = end < content.length;
    return { format: section === "raw" ? "text" : "json-fragment", data: content.slice(offset, end), revision: current.revision, truncated,
      ...(truncated ? { nextCursor: Buffer.from(JSON.stringify({ binding: revision([ref, section]), offset: end })).toString("base64url") } : {}) };
  }
}
