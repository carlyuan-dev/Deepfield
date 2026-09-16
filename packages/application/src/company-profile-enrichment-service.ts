import { AppError, CompanyProfileResultSchema, toPublicError, type PublicAppError, type CompanyId, type CompanyProfileEvent, type CompanyProfileFields, type CompanyProfileIdentityHint } from "@deepfield/contracts";
import { Value } from "typebox/value";
import { normalizeCompanyProfile } from "./company-profile-validation.js";
import type { CompanyRepository } from "@deepfield/persistence";
import type { CompanyProfileCompleter } from "./ports.js";

export interface CompanyProfileFailureDiagnostic { companyId: CompanyId; code: string; attempts: number }
export interface CompanyProfileEnrichmentOptions {
  isForegroundBusy?: () => boolean;
  getResearchTopics?: (companyId: CompanyId) => string[];
  onFailure?: (failure: CompanyProfileFailureDiagnostic) => void;
}

export class CompanyProfileEnrichmentService {
  private loopPromise: Promise<void> | undefined;
  private readonly listeners = new Set<(event: CompanyProfileEvent) => void>();
  private stopped = false;
  private blocked = false;
  private queueIssue: PublicAppError | undefined;
  private configurationVersion = 0;
  constructor(private readonly companies: CompanyRepository, private readonly completer: CompanyProfileCompleter, private readonly options: CompanyProfileEnrichmentOptions = {}) {}
  start(): void { this.stopped = false; this.companies.resetEnrichingProfiles(); this.resume(); }
  enqueue(_companyId: CompanyId): void { this.resume(); }
  getIssue() { return this.queueIssue ?? this.companies.list().find((company) => company.profileStatus === "pending" && company.profileIssue?.category === "configuration")?.profileIssue; }
  retry(companyId: CompanyId): boolean {
    if (this.companies.getById(companyId)?.profileStatus !== "failed") return false;
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
  dispose(): void { this.stopped = true; this.listeners.clear(); }
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
  private emit(event: CompanyProfileEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* closed renderer */ } } }
}
