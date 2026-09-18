import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { AppError, BatchResearchEntryInputSchema, toPublicError, type BatchResearchEntryInput, type CompanyResearchBatchState, type ResearchRunId, type CapabilityItemId, type CompanyId } from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import type { CompanyResearchService } from "./company-research-service.js";

export class CompanyResearchBatchService {
  private state: CompanyResearchBatchState | undefined;
  private task: Promise<void> | undefined;
  private wakeProfileBoundary: (() => void) | undefined;
  private listeners = new Set<(state: CompanyResearchBatchState) => void>();
  private unsubscribe: () => void;
  constructor(private readonly repos: Repositories, private readonly research: CompanyResearchService, private readonly profile?: { whenIdle(): Promise<void>; resume(): void }) {
    repos.companyResearchBatches.deleteAllTerminal();
    this.state = repos.companyResearchBatches.getActive();
    if (this.state) {
      for (const entry of this.state.entries) {
        if (entry.status !== "running" || !entry.runId) continue;
        const run = repos.companyResearchRuns.getByIdForTarget(this.state.itemId as CapabilityItemId, entry.companyId as CompanyId, entry.runId as ResearchRunId);
        if (run?.status === "completed") entry.status = "completed";
        else if ((run?.status === "research_failed" || run?.status === "structure_failed") && !entry.interrupted && entry.issue?.code !== "EXTERNAL.AUTHENTICATION_FAILED") entry.status = "failed";
        else if (run?.status === "researching" || run?.status === "structuring") entry.interrupted = true;
      }
      research.cleanupAbandoned();
      this.state.status = "paused";
      this.reserve(this.state.batchId);
      this.save();
    }
    this.unsubscribe = research.subscribe(event => {
      if (event.type === "tool_activity" && event.errorCode === "authentication_failed" && this.state) {
        const entry = this.state.entries.find(e => e.runId === event.runId);
        if (entry) {
          entry.issue = toPublicError(new AppError("EXTERNAL.AUTHENTICATION_FAILED", { service: "search" }));
          this.save();
        }
      }
      if (event.type !== "state_changed" || !this.state || this.state.itemId !== event.itemId) return;
      const entry = this.state.entries.find(e => e.runId === event.runId);
      if (!entry) return;
      const run = this.repos.companyResearchRuns.getByIdForTarget(event.itemId as CapabilityItemId, event.companyId as CompanyId, event.runId as ResearchRunId);
      if (run?.status === "structuring") { entry.stage = "structure"; this.save(); }
    });
  }
  isReserved(): boolean { return !!this.state && !["completed", "cancelled"].includes(this.state.status); }
  getState(itemId: string): CompanyResearchBatchState | null {
    if (!this.repos.capabilityItems.getById(itemId as CapabilityItemId)) throw new AppError("RESOURCE.NOT_FOUND");
    return structuredClone(this.state?.itemId === itemId ? this.state : this.repos.companyResearchBatches.getLatest(itemId) ?? null);
  }
  start(itemId: string, entries: BatchResearchEntryInput[]): CompanyResearchBatchState {
    if (this.isReserved() || this.repos.companyResearchBatches.getActive()) throw new AppError("BUSINESS.CONFLICT");
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 1000 || new Set(entries.map(e => e.companyId)).size !== entries.length) throw new AppError("INPUT.INVALID");
    for (const entry of entries) {
      if (!Value.Check(BatchResearchEntryInputSchema, entry)) throw new AppError("INPUT.INVALID");
      this.research.validateBatchEntry(itemId, entry.companyId, entry.input);
    }
    const batchId = randomUUID();
    this.reserve(batchId);
    this.state = { batchId, itemId, status: "waiting_profile", entries: structuredClone(entries).map(e => ({ ...e, status: "pending" })), processed: 0, succeeded: 0, failed: 0, total: entries.length };
    try {
      this.save();
    } catch (error) {
      this.state = undefined;
      this.research.release(batchId);
      throw error;
    }
    this.launch();
    return structuredClone(this.state);
  }
  resume(batchId: string): CompanyResearchBatchState {
    const state = this.require(batchId);
    if (state.status !== "paused" || this.task) throw new AppError("BUSINESS.CONFLICT");
    state.status = "waiting_profile";
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
    this.wakeProfileBoundary?.();
    const entry = state.entries.find(e => e.status === "running");
    if (entry?.runId && this.research.isActiveRun(entry.runId)) await this.research.cancel(entry.runId);
    await this.task;
    if (this.state !== state) return; // Another cancellation already settled this owned batch.
    // A recovered run was changed to failed by single-run startup recovery. Only
    // an entry still marked running is owned unfinished work; completed entries
    // and failures already acknowledged by the queue are never removed.
    for (const pending of state.entries.filter(e => e.status === "pending" || e.status === "running")) {
      if (pending.runId) {
        const run = this.repos.companyResearchRuns.getByIdForTarget(state.itemId as CapabilityItemId, pending.companyId as CompanyId, pending.runId as ResearchRunId);
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
  dispose(): void { this.unsubscribe(); this.listeners.clear(); }
  private require(batchId: string): CompanyResearchBatchState {
    if (this.state?.batchId !== batchId) throw new AppError("RESOURCE.NOT_FOUND");
    return this.state;
  }
  private launch(): void {
    const state = this.state!;
    const cancelledAtBoundary = new Promise<void>(resolve => { this.wakeProfileBoundary = resolve; });
    const task = Promise.resolve().then(() => this.run(cancelledAtBoundary)).catch(error => {
      if (this.state !== state || this.state.status === "cancelling") return;
      this.state.status = "paused";
      this.state.issue = toPublicError(error);
      this.save();
    }).finally(() => { if (this.task === task) this.task = undefined; });
    this.task = task;
  }
  private async run(cancelledAtBoundary: Promise<void>): Promise<void> {
    const state = this.state!;
    await Promise.race([this.profile?.whenIdle(), cancelledAtBoundary]);
    if (state.status === "cancelling") return;
    state.status = "running";
    this.save();
    for (const entry of state.entries) {
      if (entry.status !== "pending" && entry.status !== "running") continue;
      if (this.cancelled()) return;
      entry.status = "running";
      entry.stage = "raw";
      delete entry.issue;
      this.save();
      let dispatchedRun: import("@deepfield/contracts").ResearchRun | undefined;
      try {
        const saved = entry.runId ? this.repos.companyResearchRuns.getByIdForTarget(state.itemId as CapabilityItemId, entry.companyId as CompanyId, entry.runId as ResearchRunId) : undefined;
        if (saved?.status === "completed") {
          entry.status = "completed";
          this.save();
          continue;
        }
        let run: import("@deepfield/contracts").ResearchRun;
        if (saved && this.research.isActiveRun(saved.id)) {
          run = saved;
        } else if (saved) {
          run = await this.research.retryFailed(state.itemId, entry.companyId, saved.id, entry.input, state.batchId, () => this.cancelled());
        } else {
          run = await this.research.start(state.itemId, entry.companyId, entry.input, state.batchId, () => this.cancelled());
        }
        dispatchedRun = run;
        entry.runId = run.id;
        entry.stage = run.status === "structuring" ? "structure" : "raw";
        delete entry.interrupted;
        this.save();
        if (this.cancelled() && this.research.isActiveRun(run.id)) await this.research.cancel(run.id);
        await this.research.whenSettled();
        const final = this.repos.companyResearchRuns.getByIdForTarget(run.itemId, run.companyId, run.id);
        if (final?.status === "completed") entry.status = "completed";
        else if (final?.status === "research_failed" || final?.status === "structure_failed") entry.status = "failed";
        else if (!this.cancelled()) throw new AppError("STORAGE.FAILED");
        delete entry.stage;
        this.save();
        const terminalIssue = this.state!.entries.find(e => e.runId === run.id)?.issue;
        if (!this.cancelled() && terminalIssue?.code === "EXTERNAL.AUTHENTICATION_FAILED") {
          if (entry.status === "failed") entry.status = "running";
          state.status = "paused";
          state.issue = terminalIssue;
          this.save();
          return;
        }
      } catch (error) {
        // A failed batch snapshot does not end an already launched research
        // worker. Keep the reservation and reject resume until its iterator has
        // settled (including acknowledgement if cancellation was requested).
        if (dispatchedRun) {
          await this.research.whenSettled();
          const settled = this.repos.companyResearchRuns.getByIdForTarget(
            dispatchedRun.itemId, dispatchedRun.companyId, dispatchedRun.id,
          );
          if (settled?.status === "completed") entry.status = "completed";
          else if (settled?.status === "research_failed" || settled?.status === "structure_failed") entry.status = "failed";
          delete entry.stage;
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
      if (this.cancelled()) return;
    }
    state.status = "completed";
    this.save();
  }
  private cancelled(): boolean { return this.state?.status === "cancelling" || this.state?.status === "cancelled"; }
  private reserve(batchId: string): void {
    this.research.reserve(batchId, run => {
      const entry = this.state!.entries.find(e => e.status === "running" && e.companyId === run.companyId)!;
      entry.runId = run.id;
      // Called inside the same SQLite transaction that creates this owned run.
      this.repos.companyResearchBatches.save(this.state!);
    });
  }
  private save(): void {
    const state = this.state!;
    state.succeeded = state.entries.filter(e => e.status === "completed").length;
    state.failed = state.entries.filter(e => e.status === "failed").length;
    state.processed = state.succeeded + state.failed;
    try {
      this.repos.runInTransaction(() => {
        this.repos.companyResearchBatches.save(state);
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
    for (const listener of this.listeners) { try { listener(structuredClone(state)); } catch { /* closed renderer */ } }
  }
}
