import type { CapabilityItemId, CompanyId, PublicAppError, ResearchRunId } from "./contracts.js";
import type { CapabilityItem, Company, CompanyDraft, CompanyProfileInput, CompanyProfileFields, CompanyProfileIdentityHint, CompanyProfileResult, CompanyProfileDiagnostic, CompanyProfileStatus, CreateIndustryResearchItemInput, ResearchRun, ActiveResearchRunSummary, CompanyResearchContext, CompanyResearchModelDiagnostic, CompanyResearchTemplateSnapshot, KeyResearchRun, ResearchRunSummary, StructuredResearchContent, ResearchFailureCode, StartCompanyResearchInput, ItemCompany, UpdateIndustryResearchItemInput } from "./contracts.js";

export interface CapabilityItemRepository {
  create(input: CreateIndustryResearchItemInput): CapabilityItem;
  update(itemId: CapabilityItemId, input: UpdateIndustryResearchItemInput): CapabilityItem | undefined;
  delete(itemId: CapabilityItemId): boolean;
  list(): CapabilityItem[];
  getById(itemId: CapabilityItemId): CapabilityItem | undefined;
}

export interface CompanyRepository {
  upsert(draft: CompanyDraft): Company;
  update(companyId: Company["id"], input: CompanyProfileInput): Company | undefined;
  completeProfile(companyId: Company["id"], fields: CompanyProfileFields, provenance?: CompanyProfileResult): Company | undefined;
  confirmProfileIdentity(companyId: Company["id"], hint: CompanyProfileIdentityHint): Company | undefined;
  setProfileStatus(companyId: Company["id"], status: CompanyProfileStatus, issue?: PublicAppError): Company | undefined;
  getNextPendingProfile(): Company | undefined;
  resetEnrichingProfiles(): number;
  getByNormalizedName(normalizedName: string): Company | undefined;
  list(): Company[];
  getById(companyId: Company["id"]): Company | undefined;
  deleteIfUnreferenced(companyId: Company["id"]): boolean;
}

export interface ItemCompanyRepository {
  add(itemId: CapabilityItemId, companyId: Company["id"], note?: string): ItemCompany;
  listByItem(itemId: CapabilityItemId): ItemCompany[];
  remove(itemId: CapabilityItemId, companyId: Company["id"]): void;
}

export interface CompanyResearchRunRepository {
  markEvidencePacketReady(runId: ResearchRunId, attemptId: string): KeyResearchRun;
  completeRawWithEvidence(runId: ResearchRunId, attemptId: string, rawReportText: string, packetState: "ready" | "budget_exceeded"): KeyResearchRun;
  /** Topic-wide usable report counts; excludes active work and report bodies. */
  summarizeByItem(itemId: CapabilityItemId): Array<{ companyId: CompanyId; count: number; latestCreatedAt: string }>;
  createResearching(
    itemId: CapabilityItemId,
    companyId: CompanyId,
    input: StartCompanyResearchInput,
    context: CompanyResearchContext,
    template: CompanyResearchTemplateSnapshot,
  ): KeyResearchRun;
  completeRaw(runId: ResearchRunId, rawReportText: string): KeyResearchRun;
  /** Records a trusted raw search completion; only researching runs are eligible. */
  markSearchSucceeded(runId: ResearchRunId): KeyResearchRun;
  failResearching(runId: ResearchRunId, code: ResearchFailureCode): KeyResearchRun;
  failStructuring(runId: ResearchRunId, code?: "structuring_failed" | "evidence_incomplete" | "context_budget_exceeded" | "storage_failed"): KeyResearchRun;
  retryResearching(
    runId: ResearchRunId,
    input: StartCompanyResearchInput,
    context: CompanyResearchContext,
    template: CompanyResearchTemplateSnapshot,
    startedAt: string,
  ): KeyResearchRun;
  retryStructuring(runId: ResearchRunId, startedAt?: string): KeyResearchRun;
  completeStructured(runId: ResearchRunId, content: StructuredResearchContent): KeyResearchRun;
  /** Throws unless the run is researching or structuring. */
  deleteActive(runId: ResearchRunId): boolean;
  /** Throws unless the specified target owns a terminal run. */
  deleteTerminal(itemId: CapabilityItemId, companyId: CompanyId, runId: ResearchRunId): boolean;
  /** @deprecated Use deleteActive; preserved while callers migrate. */
  deleteResearching(runId: ResearchRunId): boolean;
  recoverAbandoned(): { failedResearching: number; failedStructuring: number };
  getByIdForTarget(itemId: CapabilityItemId, companyId: CompanyId, runId: ResearchRunId): ResearchRun | undefined;
  /** Global occupancy, excluding report bodies and snapshots. */
  getActive(): ActiveResearchRunSummary | undefined;
  /** Completed and structure_failed summaries, newest terminal artifact first. */
  listRuns(itemId: CapabilityItemId, companyId: CompanyId): ResearchRunSummary[];
}

export interface CompanyResearchDiagnosticRepository {
  record(diagnostic: CompanyResearchModelDiagnostic): void;
  getByRequestId(requestId: string): CompanyResearchModelDiagnostic | undefined;
  getByTraceId(traceId: string): CompanyResearchModelDiagnostic | undefined;
  listByRunId(runId: string): CompanyResearchModelDiagnostic[];
  deleteByRunId(runId: string): string[];
}
export interface CompanyProfileDiagnosticRepository {
  record(diagnostic: CompanyProfileDiagnostic): void;
  getByRequestId(requestId: string): CompanyProfileDiagnostic | undefined;
  listByCompanyId(companyId: string): CompanyProfileDiagnostic[];
}

export interface CapabilityItemRow {
  id: string;
  type: "industry-research";
  industry: string;
  research_scope: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyRow {
  id: string;
  name: string;
  normalized_name: string;
  country_or_region: string | null;
  legal_name: string | null;
  aliases_json: string | null;
  headquarters: string | null;
  founded_at: string | null;
  official_website_json: string | null;
  stock_listings_json: string | null;
  business_tags_json: string | null;
  profile_status: CompanyProfileStatus;
  profile_provenance_json: string | null;
  profile_issue_json: string | null;
  profile_identity_hint_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemCompanyRow {
  item_id: string;
  company_id: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface CompanyResearchRunRow {
  evidence_policy: "required_v1" | "legacy_optional";
  evidence_attempt_id: string | null;
  evidence_packet_state: "ready" | "budget_exceeded" | null;
  id: string;
  item_id: string;
  company_id: string;
  schema_version: string;
  status: string;
  search_status: string;
  research_direction: string | null;
  focus_scope: string | null;
  as_of_date: string | null;
  research_context_json: string | null;
  template_id: string | null;
  template_version: number | null;
  template_snapshot_json: string | null;
  harness_version: number | null;
  raw_report_text: string | null;
  raw_completed_at: string | null;
  structured_content_json: string | null;
  structuring_attempts: number;
  last_failure_code: string | null;
  legacy_time_scope: string | null;
  legacy_custom_requirements: string | null;
  legacy_report_text: string | null;
  created_at: string;
  completed_at: string | null;
}
import type { createCompanyResearchBatchRepository } from "./company-research-batch-repository.js";
