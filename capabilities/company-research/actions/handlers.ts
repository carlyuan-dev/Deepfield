import { randomUUID } from "node:crypto";
import { AppError } from "@deepfield/contracts";
import type { TaskSnapshot } from "@deepfield/capability-sdk";
import type { CompanyResearchBatchService } from "../application/company-research-batch-service.js";
import type { CompanyResearchService } from "../application/company-research-service.js";
import type { RuntimeProfileResolver } from "../host-ports.js";
import { researchRetryMode, type BatchResearchEntryInput, type CompanyResearchBatchState, type StartCompanyResearchInput } from "../contracts/index.js";
import { CAPABILITY_ID, ResearchDrafts, protocolError, type PreparedResearch } from "./drafts.js";
import { TaskArtifactAdapter, type ResearchReceipt } from "./task-artifact-adapter.js";

/** The trusted UI and public action share normalization, readiness and queue admission. */
export class ResearchSubmission {
  readonly adapter: TaskArtifactAdapter;
  constructor(readonly drafts: ResearchDrafts, private readonly batch: CompanyResearchBatchService, private readonly profiles: RuntimeProfileResolver, private readonly research: CompanyResearchService,
    private readonly names?: (itemId: string, companyId: string) => { topicName: string; companyName: string }) {
    this.adapter = new TaskArtifactAdapter(drafts.store, batch, research);
    batch.setReceiptWriter(state => this.adapter.persist(state));
  }
  async submit(prepared: PreparedResearch, invocationId: string): Promise<TaskSnapshot> {
    const duplicate = this.adapter.find(invocationId);
    if (duplicate) return duplicate;
    let draft = this.drafts.validate(prepared);
    if (draft.submittedTaskId) return this.adapter.snapshot(draft.submittedTaskId);
    await this.ready(true);
    // Recheck after asynchronous configuration lookup: UI edits may have invalidated it.
    const raced = this.adapter.find(invocationId);
    if (raced) return raced;
    draft = this.drafts.validate(prepared);
    if (draft.submittedTaskId) return this.adapter.snapshot(draft.submittedTaskId);
    const { itemId, companyId, ...input } = draft.parameters;
    let taskId = "";
    this.batch.start(itemId, [{ companyId, input }], state => {
      const entry = state.entries.at(-1)!; taskId = entry.entryId!;
      this.record(state, taskId, invocationId, undefined, draft.parameters);
      this.drafts.save({ ...draft, submittedTaskId: taskId });
    });
    return this.adapter.snapshot(taskId);
  }
  async submitBatch(itemId: string, entries: BatchResearchEntryInput[], invocationId: string, retry?: { runId: string; structureOnly?: boolean }): Promise<TaskSnapshot> {
    const existing = this.adapter.find(invocationId);
    if (existing) return existing;
    const prepared = entries.map(entry => this.drafts.prepare({ itemId, companyId: entry.companyId, ...entry.input }));
    let search = true;
    if (retry) {
      if (entries.length !== 1) throw protocolError("not_found");
      const run = this.research.getRun(itemId, entries[0]!.companyId, retry.runId);
      if (!run || run.schemaVersion !== "company-research-report-v1") throw protocolError("not_found");
      search = !retry.structureOnly && researchRetryMode(run, entries[0]!.input) === "raw";
    }
    await this.ready(search);
    const raced = this.adapter.find(invocationId);
    if (raced) return raced;
    for (const draft of prepared) this.drafts.validate(draft);
    const parentTaskId = randomUUID();
    const admitted = (state: CompanyResearchBatchState) => {
      const added = state.entries.slice(-prepared.length);
      const entryIds = added.map(entry => entry.entryId!);
      added.forEach((entry, index) => {
        this.record(state, entry.entryId!, `child:${parentTaskId}:${index}`, parentTaskId, prepared[index]!.parameters);
        this.drafts.save({ ...prepared[index]!, submittedTaskId: entry.entryId! });
      });
      const now = new Date().toISOString();
      const topicName = this.displayNames(itemId, entries[0]!.companyId).topicName;
      const receipt: ResearchReceipt = { invocationId, itemId, companyId: "", entryIds, ...(topicName ? { topicName } : {}),
        snapshot: { taskRef: { capabilityId: CAPABILITY_ID, taskId: parentTaskId }, status: "queued", createdAt: now, updatedAt: now, cancellable: true } };
      this.drafts.store.saveTask(parentTaskId, invocationId, JSON.stringify(receipt));
    };
    if (retry) {
      if (retry.structureOnly) this.batch.enqueueRetryStructuring(itemId, entries[0]!.companyId, retry.runId, admitted);
      else this.batch.enqueueRetryFailed(itemId, entries[0]!.companyId, retry.runId, entries[0]!.input, admitted);
    } else this.batch.start(itemId, prepared.map(({ parameters: { companyId, itemId: _item, ...input } }) => ({ companyId, input })), admitted);
    return this.adapter.snapshot(parentTaskId);
  }
  async submitUi(itemId: string, entries: BatchResearchEntryInput[], retry?: { runId: string; structureOnly?: boolean }): Promise<CompanyResearchBatchState> {
    // Ordinary local forms are persisted only on submission, not every keystroke.
    const prepared = entries.map(entry => this.drafts.prepare({ itemId, companyId: entry.companyId, ...entry.input }));
    let search = true;
    if (retry) {
      const run = this.research.getRun(itemId, entries[0]!.companyId, retry.runId);
      if (!run || run.schemaVersion !== "company-research-report-v1") throw protocolError("not_found");
      search = !retry.structureOnly && researchRetryMode(run, entries[0]!.input) === "raw";
    }
    await this.ready(search);
    for (const draft of prepared) this.drafts.validate(draft);
    const admitted = (state: CompanyResearchBatchState) => {
      const added = state.entries.slice(-prepared.length);
      added.forEach((entry, index) => {
        this.record(state, entry.entryId!, `ui:${randomUUID()}`, undefined, prepared[index]!.parameters);
        this.drafts.save({ ...prepared[index]!, submittedTaskId: entry.entryId! });
      });
    };
    if (retry) return retry.structureOnly
      ? this.batch.enqueueRetryStructuring(itemId, entries[0]!.companyId, retry.runId, admitted)
      : this.batch.enqueueRetryFailed(itemId, entries[0]!.companyId, retry.runId, entries[0]!.input, admitted);
    return this.batch.start(itemId, prepared.map(({ parameters: { companyId, itemId: _item, ...input } }) => ({ companyId, input })), admitted);
  }
  async retryStructureUi(itemId: string, companyId: string, runId: string) {
    const run = this.research.getRun(itemId, companyId, runId);
    if (!run || run.schemaVersion !== "company-research-report-v1") throw protocolError("not_found");
    const input: StartCompanyResearchInput = { direction: run.direction, asOfDate: run.asOfDate, ...(run.focusScope ? { focusScope: run.focusScope } : {}) };
    return this.submitUi(itemId, [{ companyId, input }], { runId, structureOnly: true });
  }
  private async ready(search: boolean): Promise<void> {
    const llm = await this.profiles.resolveActiveLlm();
    if (!llm.apiKey?.trim()) throw new AppError("CONFIG.CREDENTIAL_MISSING", { service: "llm" });
    if (search) { const profile = await this.profiles.resolveActiveSearch(); if (!profile.apiKey?.trim()) throw new AppError("CONFIG.CREDENTIAL_MISSING", { service: "search" }); }
  }
  private displayNames(itemId: string, companyId: string): { topicName?: string; companyName?: string } {
    try {
      const names = this.names?.(itemId, companyId);
      const bounded = (value: unknown) => typeof value === "string" && value.trim() ? value.slice(0, 160) : undefined;
      const topicName = bounded(names?.topicName);
      const companyName = bounded(names?.companyName);
      return { ...(topicName ? { topicName } : {}), ...(companyName ? { companyName } : {}) };
    } catch { return {}; }
  }
  private record(state: CompanyResearchBatchState, taskId: string, invocationId: string, parentTaskId?: string, parameters?: { direction: string; asOfDate: string }): void {
    const entry = state.entries.find(candidate => candidate.entryId === taskId)!;
    const now = new Date().toISOString();
    const receipt: ResearchReceipt = { invocationId, itemId: entry.itemId!, companyId: entry.companyId, ...(parentTaskId ? { parentTaskId } : {}),
      ...this.displayNames(entry.itemId!, entry.companyId), ...(parameters ? { direction: parameters.direction, asOfDate: parameters.asOfDate } : {}),
      snapshot: { taskRef: { capabilityId: CAPABILITY_ID, taskId }, status: "queued", createdAt: now, updatedAt: now, cancellable: true } };
    this.drafts.store.saveTask(taskId, invocationId, JSON.stringify(receipt));
  }
}
