import type { Database } from "@deepfield/base/database";
import type { ToolsAuditService } from "@deepfield/base/tools";
import { createCapabilityItemRepository } from "./capability-item-repository.js";
import { createCompanyRepository } from "./company-repository.js";
import { createItemCompanyRepository } from "./item-company-repository.js";
import { createCompanyResearchRunRepository } from "./company-research-run-repository.js";
import { createCompanyResearchBatchRepository } from "./company-research-batch-repository.js";
import { createCompanyResearchProtocolRepository } from "./company-research-protocol-repository.js";
import { createCompanyResearchEvidenceRepository } from "./company-research-evidence-repository.js";
import { createCompanyResearchDiagnosticRepository } from "./company-research-diagnostic-repository.js";
import { createCompanyProfileDiagnosticRepository } from "./company-profile-diagnostic-repository.js";
export type * from "./types.js";
export { normalizeCompanyName } from "./company-repository.js";

export function createCompanyResearchRepositories(db: Database, audit: ToolsAuditService) {
  return {
    capabilityItems: createCapabilityItemRepository(db), companies: createCompanyRepository(db),
    itemCompanies: createItemCompanyRepository(db), companyResearchRuns: createCompanyResearchRunRepository(db),
    companyResearchBatches: createCompanyResearchBatchRepository(db), companyResearchProtocol: createCompanyResearchProtocolRepository(db),
    companyResearchEvidence: createCompanyResearchEvidenceRepository(db), companyResearchDiagnostics: createCompanyResearchDiagnosticRepository(db),
    companyProfileDiagnostics: createCompanyProfileDiagnosticRepository(db), toolExecutions: audit,
    runInTransaction<T>(work: () => T): T { return db.transaction(work as () => T extends PromiseLike<unknown> ? never : T); },
  };
}
export type Repositories = ReturnType<typeof createCompanyResearchRepositories>;

/** Historical host migrations 1–32 establish baseline 0; no new business DDL. */
export function checkCompanyResearchBaseline(db: Database): void {
  const tables: Record<string, readonly string[]> = {
    capability_items: ["id", "type", "industry", "research_scope", "notes", "created_at", "updated_at"],
    companies: ["id", "name", "normalized_name", "country_or_region", "created_at", "updated_at", "legal_name", "aliases_json", "headquarters", "founded_at", "official_website_json", "stock_listings_json", "business_tags_json", "profile_status", "profile_provenance_json", "profile_issue_json", "profile_identity_hint_json"],
    capability_item_companies: ["item_id", "company_id", "note", "created_at", "updated_at"],
    company_research_runs: ["id", "item_id", "company_id", "schema_version", "status", "research_direction", "focus_scope", "as_of_date", "research_context_json", "template_id", "template_version", "template_snapshot_json", "harness_version", "raw_report_text", "raw_completed_at", "structured_content_json", "structuring_attempts", "last_failure_code", "legacy_time_scope", "legacy_custom_requirements", "legacy_report_text", "created_at", "completed_at", "search_status", "evidence_policy", "evidence_attempt_id", "evidence_packet_state"],
    company_research_batches: ["id", "item_id", "status", "snapshot"],
    company_research_drafts: ["id", "data"], company_research_tasks: ["id", "invocation_id", "data", "finished_at"],
    company_research_model_diagnostics: ["diagnostic_id", "request_id", "run_id", "trace_id", "stage", "phase", "agent_turns", "search_calls", "fetch_calls", "max_model_input_chars_estimate", "output_chars", "stop_reason", "error_category", "attempt", "validation_issues_json", "failed_candidate", "started_at", "finished_at", "duration_ms", "evidence_json"],
    company_profile_diagnostics: ["request_id", "company_id", "diagnostic_json", "created_at"],
    company_research_evidence_blobs: ["run_id", "attempt_id", "hash", "text"],
    company_research_evidence_events: ["run_id", "attempt_id", "sequence", "event_json"],
    company_research_evidence_snapshots: ["run_id", "attempt_id", "snapshot_json"],
    company_research_evidence_packets: ["run_id", "attempt_id", "packet_json"],
  };
  for (const [table, columns] of Object.entries(tables)) {
    const stored = new Set(db.all(`PRAGMA table_info("${table}")`).map(row => row.name));
    if (columns.some(column => !stored.has(column))) throw new Error("company_research_baseline_mismatch");
  }
}
