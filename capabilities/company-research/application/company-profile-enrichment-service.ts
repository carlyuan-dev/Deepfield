import { AppError, toPublicError, type PublicAppError, type CompanyId } from "@deepfield/contracts";
import { CompanyProfileResultSchema, type CompanyProfileEvent, type CompanyProfileFields, type CompanyProfileIdentityHint } from "../contracts/index.js";
import { Value } from "typebox/value";
import { normalizeCompanyProfile } from "./company-profile-validation.js";
import type { ProfileRepository as CompanyRepository } from "../host-ports.js";
import type { CompanyProfileCompleter } from "../host-ports.js";
import type { CompanyProfileProgress } from "../contracts/index.js";

export interface CompanyProfileFailureDiagnostic { companyId: CompanyId; code: string; attempts: number }
export interface CompanyProfileEnrichmentOptions {
  isForegroundBusy?: () => boolean;
  getResearchTopics?: (companyId: CompanyId) => string[];
  getTopicCompanyIds?: (itemId: string) => CompanyId[];
  getTopicIds?: () => string[];
  onFailure?: (failure: CompanyProfileFailureDiagnostic) => void;
}

export class CompanyProfileEnrichmentService {
  private loopPromise: Promise<void> | undefined;
  private readonly listeners = new Set<(event: CompanyProfileEvent) => void>();
  private stopped = false;
  private blocked = false;
  private queueIssue: PublicAppError | undefined;
  private configurationVersion = 0;
  private cohorts = new Map<string, Set<CompanyId>>();
  private finalizingProgress = new Map<string, CompanyProfileProgress>();
  private progressListeners = new Set<(progress: CompanyProfileProgress) => void>();
  private progressPublications: CompanyProfileProgress[] = [];
  private publishingProgress = false;
  private progressPublicationDeferrals = 0;
  getProgress(itemId: string): CompanyProfileProgress {
    const tracked = this.cohorts.get(itemId);
    if (tracked) return this.progressFor(itemId, tracked);
    const finalizing = this.finalizingProgress.get(itemId);
    if (finalizing) return finalizing;
    const ids = this.options.getTopicCompanyIds?.(itemId) ?? [];
    const companies = ids.map(id => this.companies.getById(id)).filter(c => c !== undefined);
    const pending = companies.filter(c => c.profileStatus === "pending" || c.profileStatus === "enriching");
    return pending.length ? this.progressFor(itemId, new Set(pending.map(company => company.id))) : this.idleProgress(itemId);
  }
  private idleProgress(itemId: string): CompanyProfileProgress {
    return { itemId, status: "idle", processed: 0, total: 0, failed: 0 };
  }
  private progressFor(itemId: string, cohort: Set<CompanyId>): CompanyProfileProgress {
    const ids = this.options.getTopicCompanyIds?.(itemId) ?? [];
    const companies = ids.map(id => this.companies.getById(id)).filter(c => c !== undefined);
    const members = companies.filter(c => cohort.has(c.id));
    if (!members.length) return this.idleProgress(itemId);
    const processed = members.filter(c => c.profileStatus === "ready" || c.profileStatus === "failed").length;
    const pending = members.filter(c => c.profileStatus === "pending" || c.profileStatus === "enriching");
    const issue = pending.length ? this.getIssue() : undefined;
    return { itemId, total: members.length, processed, failed: members.filter(c => c.profileStatus === "failed").length,
      status: !members.length ? "idle" : !pending.length ? "completed" : issue ? "paused" : pending.some(c => c.profileStatus === "enriching") ? "running" : "waiting", ...(issue ? { issue } : {}) };
  }
  subscribeProgress(listener: (progress: CompanyProfileProgress) => void): () => void { this.progressListeners.add(listener); return () => this.progressListeners.delete(listener); }
  constructor(private readonly companies: CompanyRepository, private readonly completer: CompanyProfileCompleter, private readonly options: CompanyProfileEnrichmentOptions = {}) {}
  start(): void { this.stopped = false; this.companies.resetEnrichingProfiles(); this.captureProgress(); this.resume(); }
  enqueue(_companyId: CompanyId): void { this.captureProgress(); this.resume(); }
  membershipsChanged(itemId: string): void {
    const cohort = this.cohorts.get(itemId);
    if (!cohort) {
      this.finalizingProgress.delete(itemId);
      this.publishProgress(this.getProgress(itemId));
      return;
    }
    const progress = this.progressFor(itemId, cohort);
    if (progress.status === "completed" || progress.status === "idle") {
      this.cohorts.delete(itemId);
      if (progress.status === "completed") this.finalizingProgress.set(itemId, progress);
    }
    this.publishProgress(progress);
  }
  private captureProgress(): void {
    for (const itemId of [...(this.options.getTopicIds?.() ?? [])]) {
      const ids = this.options.getTopicCompanyIds?.(itemId) ?? [];
      const pending = ids.map(id => this.companies.getById(id)).filter(c => c?.profileStatus === "pending" || c?.profileStatus === "enriching");
      let cohort = this.cohorts.get(itemId);
      if (!cohort && pending.length) { cohort = new Set(); this.cohorts.set(itemId, cohort); }
      if (!cohort) continue;
      for (const company of pending) cohort.add(company!.id);
      const progress = this.progressFor(itemId, cohort);
      if (progress.status === "completed" || progress.status === "idle") {
        this.cohorts.delete(itemId);
        if (progress.status === "completed") this.finalizingProgress.set(itemId, progress);
      }
      this.publishProgress(progress);
    }
  }
  private publishProgress(progress: CompanyProfileProgress): void {
    this.progressPublications.push(progress);
    this.drainProgressPublications();
  }
  private drainProgressPublications(): void {
    if (this.publishingProgress || this.progressPublicationDeferrals > 0) return;
    this.publishingProgress = true;
    try {
      while (this.progressPublications.length) {
        const next = this.progressPublications.shift()!;
        for (const listener of [...this.progressListeners]) {
          try { listener(next); } catch { /* closed renderer */ }
        }
        if (next.status === "completed" && this.finalizingProgress.get(next.itemId) === next) this.finalizingProgress.delete(next.itemId);
      }
    } finally { this.publishingProgress = false; }
  }
  getIssue() { return this.queueIssue ?? this.companies.list().find((company) => company.profileStatus === "pending" && company.profileIssue?.category === "configuration")?.profileIssue; }
  retry(companyId: CompanyId): boolean {
    const company = this.companies.getById(companyId);
    if (!company || (company.profileStatus !== "failed" && company.profileStatus !== "ready")) return false;
    this.companies.setProfileStatus(companyId, "pending");
    this.emit({ companyId, status: "pending" }); this.resume(); return true;
  }
  confirmIdentity(companyId: CompanyId, hint: CompanyProfileIdentityHint): boolean {
    const saved = this.companies.confirmProfileIdentity(companyId, hint);
    if (!saved) return false;
    this.emit({ companyId, status: "pending" });
    this.resume();
    return true;
  }
  configurationChanged(): void {
    this.configurationVersion += 1;
    this.blocked = false;
    this.queueIssue = undefined;
    for (const company of this.companies.list()) if (company.profileStatus === "pending" && company.profileIssue) {
      this.companies.setProfileStatus(company.id, "pending"); this.emit({ companyId: company.id, status: "pending" });
    }
    this.resume();
  }
  resume(): void {
    if (this.stopped || this.blocked || this.loopPromise) return;
    this.loopPromise = Promise.resolve().then(() => this.runLoop()).catch(() => {
      this.blocked = true;
      this.queueIssue = toPublicError(new AppError("STORAGE.FAILED"));
      try {
        const pending = this.companies.getNextPendingProfile();
        if (pending) this.emit({ companyId: pending.id, status: "pending", issue: this.queueIssue });
      } catch { /* Repository unavailable; getIssue still exposes the safe queue failure. */ }
    }).finally(() => {
      this.loopPromise = undefined;
      try {
        if (!this.stopped && !this.blocked && !this.options.isForegroundBusy?.() && this.companies.getNextPendingProfile()) this.resume();
      } catch {
        this.blocked = true;
        this.queueIssue = toPublicError(new AppError("STORAGE.FAILED"));
      }
    });
  }
  async whenIdle(): Promise<void> { await this.loopPromise; }
  subscribe(listener: (event: CompanyProfileEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void { this.stopped = true; this.listeners.clear(); this.progressListeners.clear(); }
  private async runLoop(): Promise<void> {
    while (!this.stopped && !this.blocked && !this.options.isForegroundBusy?.()) {
      const company = this.companies.getNextPendingProfile();
      if (!company) return;
      const version = this.configurationVersion;
      let claimed = false;
      try {
        const topics = [...new Set((this.options.getResearchTopics?.(company.id) ?? []).map((topic) => topic.trim()).filter(Boolean))];
        const run = await this.completer.prepare(company, topics);
        if (this.stopped || this.options.isForegroundBusy?.()) return;
        if (version !== this.configurationVersion) continue;
        if (this.companies.getById(company.id)?.profileStatus !== "pending") continue;
        this.companies.setProfileStatus(company.id, "enriching"); claimed = true;
        this.emit({ companyId: company.id, status: "enriching" });
        const result = await run();
        if (this.stopped || this.companies.getById(company.id)?.profileStatus !== "enriching") continue;
        if (!Value.Check(CompanyProfileResultSchema, result)) throw new AppError("INTERNAL.UNKNOWN");
        let fields: CompanyProfileFields = {};
        if (result.identity.disposition === "matched") {
          if (!result.identity.matchedName?.trim() || !Object.keys(result.fields).length) throw new AppError("INTERNAL.UNKNOWN");
          const { name: _name, ...normalized } = normalizeCompanyProfile({ name: company.name, ...result.fields });
          fields = normalized;
          if (fields.headquarters !== undefined && !/\p{Script=Han}/u.test(fields.headquarters)) throw new AppError("INTERNAL.UNKNOWN");
        }
        const saved = this.companies.completeProfile(company.id, fields, { ...result, fields });
        if (saved) this.emit({ companyId: company.id, status: saved.profileStatus });
      } catch (error) {
        if (this.stopped) return;
        const current = this.companies.getById(company.id);
        if (!current || current.profileStatus !== (claimed ? "enriching" : "pending")) continue;
        const issue = toPublicError(error);
        if (issue.category === "configuration") {
          if (version !== this.configurationVersion) { this.companies.setProfileStatus(company.id, "pending"); continue; }
          this.blocked = true;
          this.queueIssue = issue;
          this.companies.setProfileStatus(company.id, "pending", issue);
          this.emit({ companyId: company.id, status: "pending", issue });
          return;
        }
        try { this.options.onFailure?.({ companyId: company.id, code: issue.code, attempts: claimed ? 1 : 0 }); } catch { /* diagnostics do not own queue progress */ }
        this.companies.setProfileStatus(company.id, "failed", issue);
        this.emit({ companyId: company.id, status: "failed", issue });
      }
    }
  }
  private emit(event: CompanyProfileEvent): void {
    this.progressPublicationDeferrals += 1;
    try {
      this.captureProgress();
      for (const listener of [...this.listeners]) { try { listener(event); } catch { /* closed renderer */ } }
    } finally {
      this.progressPublicationDeferrals -= 1;
      this.drainProgressPublications();
    }
  }
}
