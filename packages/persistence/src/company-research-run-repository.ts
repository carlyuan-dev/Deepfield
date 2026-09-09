import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CapabilityItemId,
  CompanyId,
  ResearchRun,
  ResearchRunId,
  StartCompanyResearchInput,
} from "@deepfield/contracts";
import type {
  CompanyResearchRunRepository,
  CompanyResearchRunRow,
} from "./types.js";

function toResearchRun(row: CompanyResearchRunRow): ResearchRun {
  return {
    id: row.id as ResearchRunId,
    itemId: row.item_id as CapabilityItemId,
    companyId: row.company_id as CompanyId,
    status: row.status,
    timeScope: row.time_scope,
    ...(row.custom_requirements !== null
      ? { customRequirements: row.custom_requirements }
      : {}),
    ...(row.report_text !== null ? { reportText: row.report_text } : {}),
    createdAt: row.created_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  };
}

function normalizeInput(input: StartCompanyResearchInput): {
  timeScope: string;
  customRequirements?: string;
} {
  const timeScope = input.timeScope.trim();
  if (timeScope.length === 0 || timeScope.length > 300) {
    throw new Error("research time scope must be between 1 and 300 characters");
  }
  const customRequirements = input.customRequirements?.trim();
  if (customRequirements !== undefined && customRequirements.length > 4000) {
    throw new Error("research custom requirements must be at most 4000 characters");
  }
  return {
    timeScope,
    ...(customRequirements !== undefined && customRequirements.length > 0
      ? { customRequirements }
      : {}),
  };
}

export function createCompanyResearchRunRepository(
  db: DatabaseSync,
): CompanyResearchRunRepository {
  return {
    createRunning(itemId, companyId, input) {
      const normalized = normalizeInput(input);
      const now = new Date().toISOString();
      const run: ResearchRun = {
        id: randomUUID() as ResearchRunId,
        itemId,
        companyId,
        status: "running",
        timeScope: normalized.timeScope,
        ...(normalized.customRequirements !== undefined
          ? { customRequirements: normalized.customRequirements }
          : {}),
        createdAt: now,
      };
      db.prepare(
        `INSERT INTO company_research_runs(
          id, item_id, company_id, status, time_scope, custom_requirements,
          report_text, created_at, completed_at
        ) VALUES (?, ?, ?, 'running', ?, ?, NULL, ?, NULL)`,
      ).run(
        run.id,
        run.itemId,
        run.companyId,
        run.timeScope,
        run.customRequirements ?? null,
        run.createdAt,
      );
      return run;
    },

    complete(runId, reportText) {
      if (reportText.trim().length === 0) {
        throw new Error("research report must not be blank");
      }
      const completedAt = new Date().toISOString();
      const result = db
        .prepare(
          `UPDATE company_research_runs
           SET status = 'completed', report_text = ?, completed_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(reportText, completedAt, runId);
      if (result.changes === 0) {
        throw new Error("running research run not found");
      }
      const completed = this.getById(runId);
      if (completed === undefined) {
        throw new Error("completed research run not found");
      }
      return completed;
    },

    delete(runId) {
      return db.prepare("DELETE FROM company_research_runs WHERE id = ?").run(runId).changes > 0;
    },

    deleteAllRunning() {
      return Number(
        db.prepare("DELETE FROM company_research_runs WHERE status = 'running'").run().changes,
      );
    },

    getById(runId) {
      const row = db
        .prepare("SELECT * FROM company_research_runs WHERE id = ?")
        .get(runId) as unknown as CompanyResearchRunRow | undefined;
      return row === undefined ? undefined : toResearchRun(row);
    },

    getRunning() {
      const row = db
        .prepare("SELECT * FROM company_research_runs WHERE status = 'running' LIMIT 1")
        .get() as unknown as CompanyResearchRunRow | undefined;
      return row === undefined ? undefined : toResearchRun(row);
    },

    listCompleted(itemId, companyId) {
      const rows = db
        .prepare(
          `SELECT * FROM company_research_runs
           WHERE item_id = ? AND company_id = ? AND status = 'completed'
           ORDER BY completed_at DESC, id DESC`,
        )
        .all(itemId, companyId) as unknown as CompanyResearchRunRow[];
      return rows.map(toResearchRun);
    },
  };
}
