import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import {
  CompanyResearchModelDiagnosticSchema,
  type CompanyResearchModelDiagnostic,
} from "@deepfield/contracts";
import type { CompanyResearchDiagnosticRepository } from "./types.js";

interface DiagnosticRow {
  request_id: string;
  run_id: string;
  trace_id: string;
  stage: "raw" | "structure";
  phase: "deciding" | "synthesizing" | "structuring";
  agent_turns: number;
  search_calls: number;
  fetch_calls: number;
  max_model_input_chars_estimate: number;
  output_chars: number;
  stop_reason: CompanyResearchModelDiagnostic["stopReason"];
  error_category: CompanyResearchModelDiagnostic["errorCategory"] | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

function valid(value: unknown): CompanyResearchModelDiagnostic {
  if (!Value.Check(CompanyResearchModelDiagnosticSchema, value)) throw new Error("invalid company research diagnostic");
  return structuredClone(value);
}

function fromRow(row: DiagnosticRow): CompanyResearchModelDiagnostic {
  return valid({
    requestId: row.request_id, runId: row.run_id, traceId: row.trace_id, stage: row.stage,
    type: "model_diagnostic", phase: row.phase, agentTurns: row.agent_turns,
    searchCalls: row.search_calls, fetchCalls: row.fetch_calls,
    maxModelInputCharsEstimate: row.max_model_input_chars_estimate,
    outputChars: row.output_chars, stopReason: row.stop_reason,
    ...(row.error_category === null ? {} : { errorCategory: row.error_category }),
    startedAt: row.started_at, finishedAt: row.finished_at, durationMs: row.duration_ms,
  });
}

export function createCompanyResearchDiagnosticRepository(db: DatabaseSync): CompanyResearchDiagnosticRepository {
  const select = "SELECT * FROM company_research_model_diagnostics";
  return {
    record(value) {
      const record = valid(value);
      db.prepare(`INSERT INTO company_research_model_diagnostics(
        request_id, run_id, trace_id, stage, phase, agent_turns, search_calls, fetch_calls,
        max_model_input_chars_estimate, output_chars, stop_reason, error_category, started_at, finished_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(record.requestId, record.runId, record.traceId, record.stage, record.phase,
          record.agentTurns, record.searchCalls, record.fetchCalls, record.maxModelInputCharsEstimate,
          record.outputChars, record.stopReason, record.errorCategory ?? null,
          record.startedAt, record.finishedAt, record.durationMs);
    },
    getByRequestId(requestId) {
      const row = db.prepare(`${select} WHERE request_id = ?`).get(requestId) as unknown as DiagnosticRow | undefined;
      return row === undefined ? undefined : fromRow(row);
    },
    getByTraceId(traceId) {
      const row = db.prepare(`${select} WHERE trace_id = ? ORDER BY started_at DESC, request_id DESC LIMIT 1`).get(traceId) as unknown as DiagnosticRow | undefined;
      return row === undefined ? undefined : fromRow(row);
    },
    listByRunId(runId) {
      const rows = db.prepare(`${select} WHERE run_id = ? ORDER BY started_at ASC, request_id ASC`).all(runId) as unknown as DiagnosticRow[];
      return rows.map(fromRow);
    },
  };
}
