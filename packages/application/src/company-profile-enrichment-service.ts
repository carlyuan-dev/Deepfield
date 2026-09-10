import type {
  CompanyId,
  CompanyProfileFields,
  CompanyProfileEvent,
} from "@deepfield/contracts";
import { CompanyProfileFieldsSchema } from "@deepfield/contracts";
import { Value } from "typebox/value";
import { normalizeCompanyProfile } from "./company-profile-validation.js";
import type { CompanyRepository } from "@deepfield/persistence";
import type { CompanyCompleter } from "./ports.js";

export interface CompanyProfileFailureDiagnostic {
  companyId: CompanyId;
  code: string;
  httpStatus?: number;
  fields?: string[];
  incompleteReason?: string;
  attempts: number;
}

export interface CompanyProfileEnrichmentOptions {
  isForegroundBusy?: () => boolean;
  getResearchTopics?: (companyId: CompanyId) => string[];
  onFailure?: (failure: CompanyProfileFailureDiagnostic) => void;
}

function errorRecord(error: unknown): Record<string, unknown> {
  return typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
}

function isRetryable(error: unknown): boolean {
  const record = errorRecord(error);
  if (record.code === "http_error") {
    return record.httpStatus === 408 || record.httpStatus === 429 ||
      (typeof record.httpStatus === "number" && record.httpStatus >= 500);
  }
  return [
    "network_error",
    "timeout",
    "response_incomplete",
    "output_missing",
    "invalid_json",
    "schema_invalid",
    "semantic_invalid",
  ].includes(String(record.code));
}

function sanitizeIncompleteReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value === "max_output_tokens" || value === "content_filter" ? value : "unknown";
}

function containsChineseText(value: string): boolean {
  return /\p{Script=Han}/u.test(value);
}

export class CompanyProfileEnrichmentService {
  private loopPromise: Promise<void> | undefined;
  private readonly listeners = new Set<(event: CompanyProfileEvent) => void>();
  private readonly isForegroundBusy: () => boolean;
  private readonly getResearchTopics: (companyId: CompanyId) => string[];
  private readonly onFailure: (failure: CompanyProfileFailureDiagnostic) => void;
  private stopped = false;

  constructor(
    private readonly companies: CompanyRepository,
    private readonly completer: CompanyCompleter,
    options: CompanyProfileEnrichmentOptions = {},
  ) {
    this.isForegroundBusy = options.isForegroundBusy ?? (() => false);
    this.getResearchTopics = options.getResearchTopics ?? (() => []);
    this.onFailure = options.onFailure ?? ((failure) => {
      console.warn("Company profile enrichment failed", failure);
    });
  }

  start(): void {
    this.stopped = false;
    this.companies.resetEnrichingProfiles();
    this.resume();
  }

  enqueue(_companyId: CompanyId): void {
    this.resume();
  }

  retry(companyId: CompanyId): boolean {
    if (this.companies.getById(companyId)?.profileStatus !== "failed") return false;
    const pending = this.companies.setProfileStatus(companyId, "pending");
    if (pending === undefined) return false;
    this.emit({ companyId, status: "pending" });
    this.resume();
    return true;
  }

  resume(): void {
    if (this.stopped || this.loopPromise !== undefined) return;
    this.loopPromise = Promise.resolve()
      .then(() => this.runLoop())
      .catch(() => {})
      .finally(() => {
        this.loopPromise = undefined;
        if (!this.stopped && !this.isForegroundBusy() && this.companies.getNextPendingProfile() !== undefined) {
          this.resume();
        }
      });
  }

  async whenIdle(): Promise<void> {
    await this.loopPromise;
  }

  subscribe(listener: (event: CompanyProfileEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.stopped = true;
    this.listeners.clear();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped && !this.isForegroundBusy()) {
      const company = this.companies.getNextPendingProfile();
      if (company === undefined) return;
      const enriching = this.companies.setProfileStatus(company.id, "enriching");
      if (enriching === undefined) continue;
      this.emit({ companyId: company.id, status: "enriching" });
      const researchTopics = [...new Set(this.getResearchTopics(company.id)
        .map((topic) => topic.trim())
        .filter((topic) => topic.length > 0))];
      let finalError: unknown;
      let completedSuccessfully = false;
      let attempts = 0;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        attempts = attempt;
        try {
          const fields = await this.completer.complete(
            company.name,
            researchTopics.length > 0 ? { researchTopics } : undefined,
          );
          if (this.stopped) return;
          if (!Value.Check(CompanyProfileFieldsSchema, fields)) {
            throw Object.assign(new Error("invalid company profile completion"), {
              code: "schema_invalid",
              fields: typeof fields === "object" && fields !== null ? Object.keys(fields) : undefined,
            });
          }
          let normalizedFields: CompanyProfileFields;
          try {
            const normalized = normalizeCompanyProfile({
              name: company.name,
              ...fields,
            });
            const { name: _name, ...profileFields } = normalized;
            normalizedFields = profileFields;
          } catch {
            throw Object.assign(new Error("invalid company profile completion"), {
              code: "semantic_invalid",
              fields: Object.keys(fields),
            });
          }
          if (
            normalizedFields.headquarters !== undefined &&
            !containsChineseText(normalizedFields.headquarters)
          ) {
            throw Object.assign(new Error("invalid company profile completion"), {
              code: "semantic_invalid",
              fields: ["headquarters"],
            });
          }
          if (this.companies.getById(company.id)?.profileStatus !== "enriching") {
            completedSuccessfully = true;
            break;
          }
          const completed = this.companies.completeProfile(company.id, normalizedFields);
          if (completed !== undefined) {
            this.emit({ companyId: company.id, status: "ready" });
            completedSuccessfully = true;
          }
          break;
        } catch (error) {
          finalError = error;
          if (this.companies.getById(company.id)?.profileStatus !== "enriching") {
            completedSuccessfully = true;
            break;
          }
          if (!isRetryable(error)) break;
        }
      }
      if (!completedSuccessfully && finalError !== undefined) {
        if (this.companies.getById(company.id)?.profileStatus !== "enriching") continue;
        const record = errorRecord(finalError);
        const incompleteReason = sanitizeIncompleteReason(record.incompleteReason);
        const failure: CompanyProfileFailureDiagnostic = {
          companyId: company.id,
          code: typeof record.code === "string" ? record.code : "unknown_error",
          ...(typeof record.httpStatus === "number" ? { httpStatus: record.httpStatus } : {}),
          ...(Array.isArray(record.fields) && record.fields.every((field) => typeof field === "string")
            ? { fields: record.fields as string[] }
            : {}),
          ...(incompleteReason !== undefined ? { incompleteReason } : {}),
          attempts,
        };
        try {
          this.onFailure(failure);
        } catch {
          // Diagnostics must never interrupt persistence or queue progress.
        }
        const failed = this.companies.setProfileStatus(company.id, "failed");
        if (failed !== undefined) this.emit({ companyId: company.id, status: "failed" });
      }
    }
  }

  private emit(event: CompanyProfileEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A closed renderer cannot interrupt persistence or queue progress.
      }
    }
  }
}
