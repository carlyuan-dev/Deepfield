import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { AppError, toPublicError, type ResearchRunId, type CapabilityItemId, type CompanyId } from "@deepfield/contracts";
import { BatchResearchEntryInputSchema, researchRetryMode, type BatchResearchEntry, type BatchResearchEntryInput, type CompanyResearchBatchState, type KeyResearchRun, type StartCompanyResearchInput } from "../contracts/index.js";
import type { CompanyResearchBatchServiceRepositories as Repositories } from "../host-ports.js";
import type { CompanyResearchService } from "./company-research-service.js";

export class CompanyResearchBatchService {
  private state: CompanyResearchBatchState | undefined;
  private task: Promise<void> | undefined;
  private listeners = new Set<(state: CompanyResearchBatchState) => void>();
  private entryWaiters = new Map<string, Set<() => void>>();
  private unsubscribe: () => void;
  private recovered = false;
  private disposed = false;
  private persistReceipts?: (state: CompanyResearchBatchState) => void;
  /** Called only inside the queue/run's existing SQLite transaction. */
  setReceiptWriter(writer: (state: CompanyResearchBatchState) => void): void { this.persistReceipts = writer; }
  constructor(private readonly repos: Repositories, private readonly research: CompanyResearchService, private readonly profile?: { resume(): void }) {
    this.unsubscribe = research.subscribe(event => {
      if (this.disposed) return;
      if (event.type === "tool_activity" && event.errorCode === "authentication_failed" && this.state) {
        const entry = this.state.entries.find(e => e.status === "running" && e.runId === event.runId);
        if (entry) {
          entry.issue = toPublicError(new AppError("EXTERNAL.AUTHENTICATION_FAILED", { service: "search" }));
          this.save();
        }
      }
      if (event.type !== "state_changed" || !this.state) return;
      const entry = this.state.entries.find(e => e.status === "running" && e.runId === event.runId);
      if (!entry) return;
      const run = this.repos.companyResearchRuns.getByIdForTarget(event.itemId as CapabilityItemId, event.companyId as CompanyId, event.runId as ResearchRunId);
      if (run?.status === "structuring") { entry.stage = "structure"; this.save(); }
    });
  }
  /** Reconcile persisted queue identities before single-run recovery changes their status. */
  recover(): void {
    if (this.recovered || this.disposed) return;
    this.recovered = true;
    this.repos.companyResearchBatches.deleteAllTerminal();
    this.state = this.repos.companyResearchBatches.getActive();
    if (this.state) {
      this.normalize(this.state);
      for (const entry of this.state.entries) {
        if (entry.status !== "running" || !entry.runId) continue;
        const run = this.repos.companyResearchRuns.getByIdForTarget(entry.itemId! as CapabilityItemId, entry.companyId as CompanyId, entry.runId as ResearchRunId);
        if (run?.status === "completed") entry.status = "completed";
        else if ((run?.status === "research_failed" || run?.status === "structure_failed") && !entry.interrupted && entry.issue?.code !== "EXTERNAL.AUTHENTICATION_FAILED") entry.status = "failed";
        else if (run?.status === "researching" || run?.status === "structuring") entry.interrupted = true;
      }
    }
    this.research.cleanupAbandoned();
    if (this.state) {
      this.state.status = "paused";
      this.reserve(this.state.batchId);
      this.save();
    }
  }
  isReserved(): boolean { return !!this.state && !["completed", "cancelled"].includes(this.state.status); }
  getState(itemId: string): CompanyResearchBatchState | null {
    if (!this.repos.capabilityItems.getById(itemId as CapabilityItemId)) throw new AppError("RESOURCE.NOT_FOUND");
    return structuredClone(this.state ?? null);
  }
  start(itemId: string, entries: BatchResearchEntryInput[], onQueued?: (state: CompanyResearchBatchState) => void): CompanyResearchBatchState {
    if (this.disposed) throw new AppError("BUSINESS.CONFLICT");
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 1000 || new Set(entries.map(e => e.companyId)).size !== entries.length) throw new AppError("INPUT.INVALID");
    for (const entry of entries) {
      if (!Value.Check(BatchResearchEntryInputSchema, entry)) throw new AppError("INPUT.INVALID");
      this.research.validateBatchEntry(itemId, entry.companyId, entry.input);
    }
    if (this.state) return this.append(itemId, entries.map(entry => ({ ...entry, mode: "new" as const })), onQueued);
    if (this.repos.companyResearchBatches.getActive()) throw new AppError("BUSINESS.CONFLICT");
    const batchId = randomUUID();
    this.reserve(batchId);
    this.state = { batchId, itemId, status: "running", entries: structuredClone(entries).map(e => this.createEntry(itemId, e, "new")), processed: 0, succeeded: 0, failed: 0, total: entries.length };
    try {
      this.save(() => onQueued?.(this.state!));
    } catch (error) {
      this.state = undefined;
      this.research.release(batchId);
      throw error;
    }
    this.launch();
    return structuredClone(this.state);
  }
  enqueueRetryFailed(itemId: string, companyId: string, runId: string, input: StartCompanyResearchInput, onQueued?: (state: CompanyResearchBatchState) => void): CompanyResearchBatchState {
    this.research.validateBatchEntry(itemId, companyId, input);
    const run = this.research.getRun(itemId, companyId, runId);
    if (run?.schemaVersion !== "company-research-report-v1" || researchRetryMode(run, input) === "unavailable") throw new AppError("BUSINESS.CONFLICT");
    return this.enqueue(itemId, companyId, input, "retry_failed", runId, onQueued);
  }
  enqueueRetryStructuring(itemId: string, companyId: string, runId: string, onQueued?: (state: CompanyResearchBatchState) => void): CompanyResearchBatchState {
    const run = this.research.getRun(itemId, companyId, runId);
    if (run?.schemaVersion !== "company-research-report-v1" || run.status !== "structure_failed") throw new AppError("BUSINESS.CONFLICT");
    const input: StartCompanyResearchInput = { direction: run.direction, asOfDate: run.asOfDate, ...(run.focusScope === undefined ? {} : { focusScope: run.focusScope }) };
    this.research.validateBatchEntry(itemId, companyId, input);
    return this.enqueue(itemId, companyId, input, "retry_structure", runId, onQueued);
  }
  async cancelByRunId(runId: string): Promise<void> {
    const entry = this.state?.entries.find(candidate => candidate.status === "running" && candidate.runId === runId);
    if (!entry?.entryId) throw new AppError("BUSINESS.CONFLICT");
    await this.cancelEntry(entry.entryId);
  }
  async cancelEntry(entryId: string): Promise<void> {
    const state = this.state;
    const entry = state?.entries.find(candidate => candidate.entryId === entryId);
    if (!state || !entry || (entry.status !== "pending" && entry.status !== "running")) throw new AppError("BUSINESS.CONFLICT");
    const previous = { status: entry.status, cancelRequested: entry.cancelRequested, stage: entry.stage };
    entry.cancelRequested = true;
    if (entry.status === "pending") {
      entry.status = "cancelled";
      delete entry.stage;
      try { this.save(); } catch (error) { this.restoreCancelledEntry(entry, previous); throw error; }
      return;
    }
    if (!this.task) {
      let deleteRun: (() => void) | undefined;
      if (entry.runId) {
        const saved = this.repos.companyResearchRuns.getByIdForTarget(entry.itemId! as CapabilityItemId, entry.companyId as CompanyId, entry.runId as ResearchRunId);
        if (saved?.status === "completed") entry.status = "completed";
        else {
          if (saved && (saved.status === "researching" || saved.status === "structuring")) deleteRun = () => this.repos.companyResearchRuns.deleteActive(saved.id);
          else if (saved && entry.interrupted && entry.mode === "new") deleteRun = () => this.repos.companyResearchRuns.deleteTerminal(saved.itemId, saved.companyId, saved.id);
          entry.status = "cancelled";
        }
      } else entry.status = "cancelled";
      delete entry.stage;
      try { this.save(deleteRun); } catch (error) { this.restoreCancelledEntry(entry, previous); throw error; }
      return;
    }
    try { this.save(); } catch (error) { this.restoreCancelledEntry(entry, previous); throw error; }
    const settled = new Promise<void>(resolve => {
      const waiters = this.entryWaiters.get(entryId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.entryWaiters.set(entryId, waiters);
    });
    if (entry.runId && this.research.isActiveRun(entry.runId)) await this.research.cancel(entry.runId);
    await settled;
  }
  resume(batchId: string): CompanyResearchBatchState {
    const state = this.require(batchId);
    if (state.status !== "paused" || this.task) throw new AppError("BUSINESS.CONFLICT");
    state.status = "running";
    delete state.issue;
    this.save();
    this.launch();
    return structuredClone(state);
  }
  async cancel(batchId: string): Promise<void> {
    const state = this.require(batchId);
    if (state.status === "cancelled" || state.status === "completed") return;
    state.status = "cancelling";
    this.save();
    const entry = state.entries.find(e => e.status === "running");
    if (entry?.runId && this.research.isActiveRun(entry.runId)) await this.research.cancel(entry.runId);
    await this.task;
    if (this.disposed || this.state !== state) return; // Another cancellation or disposal settled ownership.
    // A recovered run was changed to failed by single-run startup recovery. Only
    // an entry still marked running is owned unfinished work; completed entries
    // and failures already acknowledged by the queue are never removed.
    for (const pending of state.entries.filter(e => e.status === "pending" || e.status === "running")) {
      if (pending.runId) {
        const run = this.repos.companyResearchRuns.getByIdForTarget(pending.itemId! as CapabilityItemId, pending.companyId as CompanyId, pending.runId as ResearchRunId);
        if (run?.status === "completed") {
          pending.status = "completed";
          continue;
        }
        if (run && (run.status === "researching" || run.status === "structuring")) this.repos.companyResearchRuns.deleteActive(run.id);
        else if (run && pending.interrupted) this.repos.companyResearchRuns.deleteTerminal(run.itemId, run.companyId, run.id);
      }
      pending.status = "cancelled";
      delete pending.stage;
    }
    state.status = "cancelled";
    delete state.issue;
    this.save();
  }
  subscribe(listener: (state: CompanyResearchBatchState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void {
    if (!this.disposed && this.state && this.persistReceipts) {
      // Preserve the queue itself; publish a durable interrupted/paused receipt
      // without cancelling reports or allowing late worker callbacks to mutate it.
      const paused = structuredClone(this.state); paused.status = "paused";
      for (const entry of paused.entries) if (entry.status === "running") entry.interrupted = true;
      try { this.repos.runInTransaction(() => this.persistReceipts?.(paused)); }
      catch { /* Startup reconciles the durable queue; storage failure must not keep workers alive. */ }
    }
    this.disposed = true; this.unsubscribe(); this.listeners.clear();
  }
  private require(batchId: string): CompanyResearchBatchState {
    if (this.disposed) throw new AppError("BUSINESS.CONFLICT");
    if (this.state?.batchId !== batchId) throw new AppError("RESOURCE.NOT_FOUND");
    return this.state;
  }
  private launch(): void {
    const state = this.state!;
    const task = Promise.resolve().then(() => this.run()).catch(error => {
      if (this.disposed || this.state !== state || this.state.status === "cancelling") return;
      this.state.status = "paused";
      this.state.issue = toPublicError(error);
      this.save();
    }).finally(() => { if (this.task === task) this.task = undefined; });
    this.task = task;
  }
  private async run(): Promise<void> {
    const state = this.state!;
    if (this.disposed || state.status === "cancelling") return;
    for (const entry of state.entries) {
      if (entry.status !== "pending" && entry.status !== "running") continue;
      if (this.disposed || this.cancelled()) return;
      entry.status = "running";
      entry.stage = "raw";
      delete entry.issue;
      this.save();
      let dispatchedRun: import("../contracts/index.js").ResearchRun | undefined;
      try {
        const itemId = entry.itemId!;
        const savedId = entry.runId ?? entry.originalRunId;
        const saved = savedId ? this.repos.companyResearchRuns.getByIdForTarget(itemId as CapabilityItemId, entry.companyId as CompanyId, savedId as ResearchRunId) : undefined;
        if (entry.runId && saved?.status === "completed") {
          entry.status = "completed";
          this.save();
          continue;
        }
        let run: import("../contracts/index.js").ResearchRun;
        if (saved && this.research.isActiveRun(saved.id)) {
          run = saved;
        } else if (saved) {
          run = entry.mode === "retry_structure"
            ? await this.research.retryStructuring(itemId, entry.companyId, saved.id, state.batchId, () => this.cancelled() || !!entry.cancelRequested, () => this.disposed)
            : await this.research.retryFailed(itemId, entry.companyId, saved.id, entry.input, state.batchId, () => this.cancelled() || !!entry.cancelRequested, () => this.disposed);
        } else {
          if (entry.mode !== "new") throw new AppError("RESOURCE.NOT_FOUND");
          run = await this.research.start(itemId, entry.companyId, entry.input, state.batchId, () => this.cancelled() || !!entry.cancelRequested, () => this.disposed);
        }
        if (this.disposed) return;
        dispatchedRun = run;
        entry.runId = run.id;
        entry.stage = run.status === "structuring" ? "structure" : "raw";
        delete entry.interrupted;
        this.save();
        if (this.disposed) return;
        if ((this.cancelled() || entry.cancelRequested) && this.research.isActiveRun(run.id)) await this.research.cancel(run.id);
        if (this.disposed) return;
        await this.research.whenSettled();
        if (this.disposed) return;
        const final = this.repos.companyResearchRuns.getByIdForTarget(run.itemId, run.companyId, run.id);
        if (final?.status === "completed") entry.status = "completed";
        else if (entry.cancelRequested) entry.status = "cancelled";
        else if (final?.status === "research_failed" || final?.status === "structure_failed") entry.status = "failed";
        else if (!this.cancelled()) throw new AppError("STORAGE.FAILED");
        delete entry.stage;
        this.save();
        const terminalIssue = this.issueFor(entry);
        if (!this.cancelled() && terminalIssue?.code === "EXTERNAL.AUTHENTICATION_FAILED") {
          if (entry.status === "failed") entry.status = "running";
          state.status = "paused";
          state.issue = terminalIssue;
          this.save();
          return;
        }
      } catch (error) {
        if (this.disposed) return;
        // A failed batch snapshot does not end an already launched research
        // worker. Keep the reservation and reject resume until its iterator has
        // settled (including acknowledgement if cancellation was requested).
        if (dispatchedRun) {
          await this.research.whenSettled();
          if (this.disposed) return;
          const settled = this.repos.companyResearchRuns.getByIdForTarget(
            dispatchedRun.itemId, dispatchedRun.companyId, dispatchedRun.id,
          );
          if (settled?.status === "completed") entry.status = "completed";
          else if (settled?.status === "research_failed" || settled?.status === "structure_failed") entry.status = "failed";
          delete entry.stage;
        }
        if (entry.cancelRequested) {
          entry.status = "cancelled";
          delete entry.stage;
          this.save();
          continue;
        }
        if (this.cancelled()) return;
        const issue = toPublicError(error);
        entry.issue = issue;
        if (issue.category === "configuration" || issue.code === "EXTERNAL.AUTHENTICATION_FAILED" || issue.code === "STORAGE.FAILED") {
          state.status = "paused";
          state.issue = issue;
          this.save();
          return;
        }
        entry.status = "failed";
        delete entry.stage;
        this.save();
      }
      if (this.disposed || this.cancelled()) return;
    }
    state.status = "completed";
    this.save();
  }
  private cancelled(): boolean { return this.state?.status === "cancelling" || this.state?.status === "cancelled"; }
  private reserve(batchId: string): void {
    this.research.reserve(batchId, run => {
      if (this.disposed) throw new AppError("BUSINESS.CONFLICT");
      const entry = this.state!.entries.find(e => e.status === "running" && e.itemId === run.itemId && e.companyId === run.companyId)!;
      const previousRunId = entry.runId;
      entry.runId = run.id;
      // Called inside the same SQLite transaction that creates this owned run.
      try { this.repos.companyResearchBatches.save(this.state!); this.persistReceipts?.(this.state!); }
      catch (error) { if (previousRunId === undefined) delete entry.runId; else entry.runId = previousRunId; throw error; }
    });
  }
  private save(transactionalWork?: () => void): void {
    if (this.disposed) return;
    const state = this.state!;
    state.succeeded = state.entries.filter(e => e.status === "completed").length;
    state.failed = state.entries.filter(e => e.status === "failed").length;
    state.processed = state.succeeded + state.failed;
    try {
      this.repos.runInTransaction(() => {
        transactionalWork?.();
        this.repos.companyResearchBatches.save(state);
        this.persistReceipts?.(state);
        if (state.status === "completed" || state.status === "cancelled") this.repos.companyResearchBatches.deleteTerminal(state.batchId);
      });
    } catch (error) {
      // The transaction rolled back, so settlement is still owned and retryable.
      if (state.status === "cancelled") state.status = "cancelling";
      else if (state.status === "completed") state.status = "paused";
      throw new AppError("STORAGE.FAILED", undefined, { cause: error });
    }
    if (state.status === "completed" || state.status === "cancelled") {
      // Release exactly this owner before notifying: a listener may synchronously
      // admit a new batch. Its state/task must survive this batch's finalizer.
      this.state = undefined;
      this.task = undefined;
      this.research.release(state.batchId);
      this.profile?.resume();
    }
    for (const entry of state.entries) {
      if ((entry.status !== "completed" && entry.status !== "failed" && entry.status !== "cancelled") || !entry.entryId) continue;
      const waiters = this.entryWaiters.get(entry.entryId);
      if (!waiters) continue;
      this.entryWaiters.delete(entry.entryId);
      for (const resolve of waiters) resolve();
    }
    for (const listener of this.listeners) { try { listener(structuredClone(state)); } catch { /* closed renderer */ } }
  }
  private enqueue(itemId: string, companyId: string, input: StartCompanyResearchInput, mode: "retry_failed" | "retry_structure", originalRunId: string, onQueued?: (state: CompanyResearchBatchState) => void): CompanyResearchBatchState {
    if (this.disposed) throw new AppError("BUSINESS.CONFLICT");
    const entry = { companyId, input, mode, originalRunId };
    if (this.state) return this.append(itemId, [entry], onQueued);
    if (this.repos.companyResearchBatches.getActive()) throw new AppError("BUSINESS.CONFLICT");
    const batchId = randomUUID();
    this.reserve(batchId);
    this.state = { batchId, itemId, status: "running", entries: [this.createEntry(itemId, entry, mode, originalRunId)], processed: 0, succeeded: 0, failed: 0, total: 1 };
    try { this.save(() => onQueued?.(this.state!)); } catch (error) { this.state = undefined; this.research.release(batchId); throw error; }
    this.launch();
    return structuredClone(this.state);
  }
  private append(itemId: string, entries: Array<BatchResearchEntryInput & { mode: "new" | "retry_failed" | "retry_structure"; originalRunId?: string }>, onQueued?: (state: CompanyResearchBatchState) => void): CompanyResearchBatchState {
    const state = this.state!;
    if (state.status === "cancelling" || state.status === "cancelled" || state.status === "completed") throw new AppError("BUSINESS.CONFLICT");
    const activeCompanies = new Set(state.entries.filter(entry => entry.status === "pending" || entry.status === "running").map(entry => entry.companyId));
    if (entries.some(entry => activeCompanies.has(entry.companyId))) throw new AppError("BUSINESS.CONFLICT");
    const previousLength = state.entries.length;
    const previousTotal = state.total;
    state.entries.push(...entries.map(entry => this.createEntry(itemId, entry, entry.mode, entry.originalRunId)));
    state.total = state.entries.length;
    try { this.save(() => onQueued?.(state)); } catch (error) {
      state.entries.splice(previousLength);
      state.total = previousTotal;
      throw error;
    }
    return structuredClone(state);
  }
  private createEntry(itemId: string, entry: BatchResearchEntryInput, mode: "new" | "retry_failed" | "retry_structure", originalRunId?: string): BatchResearchEntry {
    return { ...structuredClone(entry), entryId: randomUUID(), itemId, mode, ...(originalRunId ? { originalRunId } : {}), status: "pending" };
  }
  private normalize(state: CompanyResearchBatchState): void {
    for (const entry of state.entries) {
      entry.entryId ??= randomUUID();
      entry.itemId ??= state.itemId;
      entry.mode ??= "new";
    }
    state.total = state.entries.length;
  }
  private issueFor(entry: BatchResearchEntry): import("@deepfield/contracts").PublicAppError | undefined { return entry.issue; }
  private restoreCancelledEntry(entry: BatchResearchEntry, previous: { status: BatchResearchEntry["status"]; cancelRequested: boolean | undefined; stage: BatchResearchEntry["stage"] | undefined }): void {
    entry.status = previous.status;
    if (previous.cancelRequested === undefined) delete entry.cancelRequested; else entry.cancelRequested = previous.cancelRequested;
    if (previous.stage === undefined) delete entry.stage; else entry.stage = previous.stage;
  }
}
