import { randomUUID } from "node:crypto";
import type { Database } from "@deepfield/base/database";
import { Value } from "typebox/value";
import { type ResearchRunId } from "./contracts.js";
import { ActiveResearchRunSummarySchema, ResearchRunSchema, ResearchRunSummarySchema, StartCompanyResearchInputSchema, type ActiveResearchRunSummary, type KeyResearchRun, type ResearchFailureCode, type ResearchRun, type ResearchRunSummary } from "./contracts.js";
import type { CompanyResearchRunRepository, CompanyResearchRunRow } from "./types.js";
import { createCompanyResearchEvidenceRepository } from "./company-research-evidence-repository.js";

function invalidRun(): never {
  // Never include stored JSON or schema-validator diagnostics in public errors.
  throw new Error("invalid persisted research run");
}

function validateRun(value: unknown): ResearchRun {
  if (!Value.Check(ResearchRunSchema, value)) invalidRun();
  if (value.schemaVersion === "legacy-freeform-v1") return value;

  const { researchContext: context, template } = value;
  if (
    context.direction !== value.direction || context.asOfDate !== value.asOfDate ||
    context.focusScope !== value.focusScope || template.templateId !== value.direction
  ) invalidRun();

  const hasRaw = value.rawReportText !== undefined && value.rawReportText.trim().length > 0 &&
    value.rawCompletedAt !== undefined;
  const hasStructure = value.structuredContent !== undefined;
  const hasCompletion = value.completedAt !== undefined;
  const hasFailure = value.lastFailureCode !== undefined;
  if (value.status === "researching") {
    if (
      value.rawReportText !== undefined || value.rawCompletedAt !== undefined ||
      hasStructure || hasCompletion || hasFailure || value.structuringAttempts !== 0
    ) invalidRun();
  } else if (value.status === "research_failed") {
    if (
      value.rawReportText !== undefined || value.rawCompletedAt !== undefined ||
      hasStructure || hasCompletion || !hasFailure || value.lastFailureCode === "structuring_failed" ||
      value.structuringAttempts !== 0
    ) invalidRun();
  } else {
    if (!hasRaw || value.structuringAttempts < 1) invalidRun();
    if (value.status === "structuring") {
      if (hasStructure || hasCompletion || hasFailure) invalidRun();
    } else if (value.status === "structure_failed") {
      if (hasStructure || hasCompletion || !["structuring_failed", "context_budget_exceeded", "evidence_incomplete", "storage_failed"].includes(value.lastFailureCode ?? "")) invalidRun();
    } else if (value.status === "completed") {
      if (!hasStructure || !hasCompletion || hasFailure) invalidRun();
    } else {
      invalidRun();
    }
  }
  return value;
}

function toResearchRun(row: CompanyResearchRunRow): ResearchRun {
  try {
    const identity = {
      id: row.id, itemId: row.item_id, companyId: row.company_id,
      schemaVersion: row.schema_version, status: row.status, createdAt: row.created_at,
      searchStatus: row.search_status,
      ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    };
    if (row.schema_version === "legacy-freeform-v1") {
      // Legacy rows cannot smuggle unvalidated new-format artifacts through reads.
      if ([
        row.research_direction, row.focus_scope, row.as_of_date, row.research_context_json,
        row.template_id, row.template_version, row.template_snapshot_json, row.harness_version,
        row.raw_report_text, row.raw_completed_at, row.structured_content_json, row.last_failure_code,
      ].some((field) => field !== null) || row.structuring_attempts !== 0) invalidRun();
      return validateRun({
        ...identity, timeScope: row.legacy_time_scope, reportText: row.legacy_report_text,
        ...(row.legacy_custom_requirements !== null ? { customRequirements: row.legacy_custom_requirements } : {}),
      });
    }
    if (
      row.legacy_time_scope !== null || row.legacy_custom_requirements !== null ||
      row.legacy_report_text !== null || row.research_context_json === null ||
      row.template_snapshot_json === null
    ) invalidRun();
    const run = validateRun({
      evidencePolicy: row.evidence_policy,
      ...(row.evidence_attempt_id === null ? {} : { attemptId: row.evidence_attempt_id }),
      ...(row.evidence_packet_state === null ? {} : { evidencePacketState: row.evidence_packet_state }),
      ...identity, direction: row.research_direction, asOfDate: row.as_of_date,
      ...(row.focus_scope !== null ? { focusScope: row.focus_scope } : {}),
      researchContext: JSON.parse(row.research_context_json),
      template: JSON.parse(row.template_snapshot_json), harnessVersion: row.harness_version,
      structuringAttempts: row.structuring_attempts,
      ...(row.raw_report_text !== null ? { rawReportText: row.raw_report_text } : {}),
      ...(row.raw_completed_at !== null ? { rawCompletedAt: row.raw_completed_at } : {}),
      ...(row.structured_content_json !== null ? { structuredContent: JSON.parse(row.structured_content_json) } : {}),
      ...(row.last_failure_code !== null ? { lastFailureCode: row.last_failure_code } : {}),
    });
    if (
      run.schemaVersion !== "company-research-report-v1" ||
      run.template.templateId !== row.template_id || run.template.templateVersion !== row.template_version
    ) invalidRun();
    return run;
  } catch {
    invalidRun();
  }
}

function toSummary(run: ResearchRun): ResearchRunSummary | ActiveResearchRunSummary {
  if (run.schemaVersion === "legacy-freeform-v1") {
    const { reportText: _reportText, ...summary } = run;
    return summary;
  }
  const {
    rawReportText: _rawReportText, structuredContent: _structuredContent,
    researchContext: _researchContext, template: _template, harnessVersion: _harnessVersion,
    ...summary
  } = run;
  if (summary.status === "researching" || summary.status === "structuring") {
    return { ...summary, status: summary.status };
  }
  return { ...summary, status: summary.status };
}

export function createCompanyResearchRunRepository(db: Database): CompanyResearchRunRepository {
  function getRequired(runId: ResearchRunId, status: KeyResearchRun["status"]): KeyResearchRun {
    const row = db.prepare("SELECT * FROM company_research_runs WHERE id = ?").get(runId) as
      unknown as CompanyResearchRunRow | undefined;
    const run = row === undefined ? undefined : toResearchRun(row);
    if (run?.schemaVersion !== "company-research-report-v1" || run.status !== status) {
      throw new Error("research run state transition rejected");
    }
    return run;
  }

  function transition(
    runId: ResearchRunId,
    from: KeyResearchRun["status"],
    change: (run: KeyResearchRun) => KeyResearchRun,
  ): KeyResearchRun {
    const next = change(getRequired(runId, from));
    validateRun(next);
    const result = db.prepare(`
      UPDATE company_research_runs
      SET status = ?, research_direction = ?, focus_scope = ?, as_of_date = ?, research_context_json = ?,
        template_id = ?, template_version = ?, template_snapshot_json = ?, harness_version = ?,
        raw_report_text = ?, raw_completed_at = ?, structured_content_json = ?, structuring_attempts = ?,
        last_failure_code = ?, created_at = ?, completed_at = ?, search_status = ?,
        evidence_policy = ?, evidence_attempt_id = ?, evidence_packet_state = ?
      WHERE id = ? AND status = ?
    `).run(
      next.status, next.direction, next.focusScope ?? null, next.asOfDate, JSON.stringify(next.researchContext),
      next.template.templateId, next.template.templateVersion, JSON.stringify(next.template), next.harnessVersion,
      next.rawReportText ?? null, next.rawCompletedAt ?? null,
      next.structuredContent === undefined ? null : JSON.stringify(next.structuredContent),
      next.structuringAttempts, next.lastFailureCode ?? null, next.createdAt, next.completedAt ?? null,
      next.searchStatus ?? "unknown", next.evidencePolicy ?? "legacy_optional", next.attemptId ?? null, next.evidencePacketState ?? null, runId, from,
    );
    if (result.changes === 0) throw new Error("research run state transition rejected");
    return structuredClone(next);
  }

  const repository: CompanyResearchRunRepository = {
    markEvidencePacketReady(runId, attemptId) {
      const run = getRequired(runId, "structuring");
      if (run.evidencePolicy !== "required_v1" || run.attemptId !== attemptId || run.evidencePacketState !== "budget_exceeded" ||
        !db.prepare("SELECT packet_json FROM company_research_evidence_packets WHERE run_id = ? AND attempt_id = ?").get(runId, attemptId)) throw new Error("evidence_incomplete: packet creation state");
      return transition(runId, "structuring", current => ({ ...current, evidencePacketState: "ready" }));
    },
    summarizeByItem(itemId) {
      return db.prepare(`
        SELECT company_id AS companyId, COUNT(*) AS count, MAX(created_at) AS latestCreatedAt
        FROM company_research_runs
        WHERE item_id = ? AND (
          (schema_version = 'legacy-freeform-v1' AND status = 'completed') OR
          (schema_version = 'company-research-report-v1' AND status IN ('completed', 'structure_failed')
            AND length(trim(raw_report_text)) > 0)
        )
        GROUP BY company_id
      `).all(itemId) as ReturnType<CompanyResearchRunRepository["summarizeByItem"]>;
    },
    createResearching(itemId, companyId, input, context, template) {
      if (!Value.Check(StartCompanyResearchInputSchema, input)) {
        throw new Error("invalid research input");
      }
      const run: KeyResearchRun = {
        evidencePolicy: "required_v1", attemptId: randomUUID(),
        id: randomUUID() as ResearchRunId, itemId, companyId,
        schemaVersion: "company-research-report-v1", status: "researching", searchStatus: "none",
        ...input, researchContext: context, template, harnessVersion: 1,
        structuringAttempts: 0, createdAt: new Date().toISOString(),
      };
      validateRun(run);
      // Both snapshots commit with the initial row, before the raw request can start.
      db.prepare(`
        INSERT INTO company_research_runs(
          id, item_id, company_id, schema_version, status,
          research_direction, focus_scope, as_of_date, research_context_json,
          template_id, template_version, template_snapshot_json, harness_version,
          structuring_attempts, created_at, search_status, evidence_policy, evidence_attempt_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id, itemId, companyId, run.schemaVersion, run.status,
        run.direction, run.focusScope ?? null, run.asOfDate, JSON.stringify(context),
        template.templateId, template.templateVersion, JSON.stringify(template), run.harnessVersion,
        run.structuringAttempts, run.createdAt, run.searchStatus!, run.evidencePolicy!, run.attemptId!,
      );
      return structuredClone(run);
    },

    markSearchSucceeded(runId) {
      return transition(runId, "researching", (run) => ({ ...run, searchStatus: "succeeded" }));
    },

    completeRaw(runId, rawReportText) {
      if (getRequired(runId, "researching").evidencePolicy === "required_v1") throw new Error("evidence_incomplete: raw completion requires freeze");
      return transition(runId, "researching", (run) => ({
        ...run, status: "structuring", rawReportText,
        rawCompletedAt: new Date().toISOString(), structuringAttempts: 1,
      }));
    },

    completeRawWithEvidence(runId, attemptId, rawReportText, packetState) {
      const run = getRequired(runId, "researching");
      if (run.evidencePolicy !== "required_v1" || run.attemptId !== attemptId) throw new Error("evidence_incomplete: raw attempt");
      const evidence = createCompanyResearchEvidenceRepository(db);
      const frozen = evidence.getFrozen(runId, attemptId);
      const packet = evidence.getPacket(runId, attemptId);
      if (!frozen || (packetState === "ready" ? !packet : Boolean(packet))) throw new Error("evidence_incomplete: raw artifacts");
      if (packet && packet.snapshotHash !== frozen.manifest.snapshotHash) throw new Error("evidence_incomplete: raw packet snapshot");
      return transition(runId, "researching", current => ({
        ...current, rawReportText, rawCompletedAt: new Date().toISOString(), structuringAttempts: 1,
        evidencePacketState: packetState, status: packetState === "ready" ? "structuring" : "structure_failed",
        ...(packetState === "budget_exceeded" ? { lastFailureCode: "context_budget_exceeded" as const } : {}),
      }));
    },

    failResearching(runId, code: ResearchFailureCode) {
      return transition(runId, "researching", (run) => ({
        ...run, status: "research_failed", lastFailureCode: code,
      }));
    },

    failStructuring(runId, code = "structuring_failed") {
      return transition(runId, "structuring", (run) => ({
        ...run, status: "structure_failed", lastFailureCode: code,
      }));
    },

    retryResearching(runId, input, context, template, startedAt) {
      if (!Value.Check(StartCompanyResearchInputSchema, input)) {
        throw new Error("invalid research input");
      }
      const row = db.prepare("SELECT * FROM company_research_runs WHERE id = ?").get(runId) as
        unknown as CompanyResearchRunRow | undefined;
      const run = row === undefined ? undefined : toResearchRun(row);
      if (
        run?.schemaVersion !== "company-research-report-v1" ||
        (run.status !== "research_failed" && run.status !== "structure_failed" &&
          !(run.status === "completed" && run.searchStatus === "none"))
      ) throw new Error("research run state transition rejected");
      return transition(runId, run.status, () => ({
        evidencePolicy: "required_v1", attemptId: randomUUID(),
        id: run.id, itemId: run.itemId, companyId: run.companyId,
        schemaVersion: "company-research-report-v1", status: "researching", searchStatus: "none",
        ...input, researchContext: context, template, harnessVersion: run.harnessVersion,
        structuringAttempts: 0, createdAt: startedAt,
      }));
    },

    retryStructuring(runId, startedAt = new Date().toISOString()) {
      return transition(runId, "structure_failed", ({ lastFailureCode: _failure, ...run }) => ({
        ...run, status: "structuring", structuringAttempts: run.structuringAttempts + 1, createdAt: startedAt,
      }));
    },

    completeStructured(runId, content) {
      return transition(runId, "structuring", (run) => ({
        ...run, status: "completed", structuredContent: content, completedAt: new Date().toISOString(),
      }));
    },

    deleteActive(runId) {
      const row = db.prepare("SELECT * FROM company_research_runs WHERE id = ?").get(runId) as
        unknown as CompanyResearchRunRow | undefined;
      const run = row === undefined ? undefined : toResearchRun(row);
      if (run?.schemaVersion !== "company-research-report-v1" || (run.status !== "researching" && run.status !== "structuring")) {
        throw new Error("research run state transition rejected");
      }
      const result = db.prepare("DELETE FROM company_research_runs WHERE id = ? AND status = ?").run(runId, run.status);
      if (result.changes === 0) throw new Error("research run state transition rejected");
      return true;
    },

    deleteTerminal(itemId, companyId, runId) {
      const row = db.prepare("SELECT * FROM company_research_runs WHERE item_id = ? AND company_id = ? AND id = ?")
        .get(itemId, companyId, runId) as unknown as CompanyResearchRunRow | undefined;
      const run = row === undefined ? undefined : toResearchRun(row);
      if (run === undefined || run.status === "researching" || run.status === "structuring") {
        throw new Error("research run state transition rejected");
      }
      const result = db.prepare("DELETE FROM company_research_runs WHERE id = ? AND item_id = ? AND company_id = ? AND status = ?")
        .run(runId, itemId, companyId, run.status);
      if (result.changes === 0) throw new Error("research run state transition rejected");
      return true;
    },

    deleteResearching(runId) {
      getRequired(runId, "researching");
      const result = db.prepare("DELETE FROM company_research_runs WHERE id = ? AND status = 'researching'").run(runId);
      if (result.changes === 0) throw new Error("research run state transition rejected");
      return true;
    },

    recoverAbandoned() {
      return db.transaction(() => {
        const rows = db.prepare("SELECT * FROM company_research_runs WHERE status IN ('researching', 'structuring')").all() as
          unknown as CompanyResearchRunRow[];
        const recovered = { failedResearching: 0, failedStructuring: 0 };
        for (const run of rows.map(toResearchRun)) {
          if (run.status === "researching") {
            repository.failResearching(run.id, "incomplete_response");
            recovered.failedResearching++;
          } else {
            let code: "structuring_failed" | "evidence_incomplete" = "structuring_failed";
            if (run.schemaVersion === "company-research-report-v1" && run.evidencePolicy === "required_v1") {
              const evidence = createCompanyResearchEvidenceRepository(db);
              try {
                const snapshot = run.attemptId ? evidence.getFrozen(run.id, run.attemptId) : undefined;
                const packet = run.attemptId ? evidence.getPacket(run.id, run.attemptId) : undefined;
                if (!snapshot || (!packet && run.evidencePacketState !== "budget_exceeded") || (packet && packet.snapshotHash !== snapshot.manifest.snapshotHash)) code = "evidence_incomplete";
              } catch (error) {
                if (error instanceof Error && error.message.startsWith("evidence_incomplete")) code = "evidence_incomplete";
                else throw error;
              }
            }
            repository.failStructuring(run.id, code);
            recovered.failedStructuring++;
          }
        }
        return recovered;
      });
    },

    getByIdForTarget(itemId, companyId, runId) {
      const row = db.prepare("SELECT * FROM company_research_runs WHERE item_id = ? AND company_id = ? AND id = ?")
        .get(itemId, companyId, runId) as unknown as CompanyResearchRunRow | undefined;
      return row === undefined ? undefined : toResearchRun(row);
    },

    getActive() {
      const row = db.prepare("SELECT * FROM company_research_runs WHERE status IN ('researching', 'structuring') LIMIT 1")
        .get() as unknown as CompanyResearchRunRow | undefined;
      if (row === undefined) return undefined;
      const summary = toSummary(toResearchRun(row));
      if (!Value.Check(ActiveResearchRunSummarySchema, summary)) invalidRun();
      return summary;
    },

    listRuns(itemId, companyId) {
      const rows = db.prepare(`
        SELECT * FROM company_research_runs
        WHERE item_id = ? AND company_id = ? AND status IN ('completed', 'research_failed', 'structure_failed')
        ORDER BY COALESCE(completed_at, raw_completed_at, created_at) DESC, id DESC
      `).all(itemId, companyId) as unknown as CompanyResearchRunRow[];
      return rows.map((row) => {
        const summary = toSummary(toResearchRun(row));
        if (!Value.Check(ResearchRunSummarySchema, summary)) invalidRun();
        return summary;
      });
    },
  };
  return repository;
}
