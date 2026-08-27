import type { DatabaseSync } from "node:sqlite";
import type {
  ToolExecution,
  ToolExecutionFinish,
  ToolExecutionRepository,
  ToolExecutionRow,
  ToolExecutionStart,
} from "./types.js";
import { sanitizeSummary } from "./summary-sanitizer.js";
import { TOOL_FAILURE_CODES, ToolExecutionError } from "./tool-execution-errors.js";
import { rowToExecution } from "./tool-execution-row-validation.js";

export { TOOL_FAILURE_CODES, ToolExecutionError } from "./tool-execution-errors.js";

// Canonical Date.toISOString() output only: YYYY-MM-DDTHH:mm:ss.sssZ.
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TERMINAL_STATUSES: readonly ToolExecutionFinish["status"][] = [
  "completed",
  "failed",
  "cancelled",
];

function invalid(): never {
  throw new ToolExecutionError("invalid_input", "invalid tool execution input");
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid();
  }
  return value;
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    invalid();
  }
  return value;
}

function requireNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid();
  }
  return value;
}

/** Canonical UTC ISO date that really exists on the calendar (round-trip check). */
function requireCanonicalIso(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_ISO.test(value)) {
    invalid();
  }
  try {
    if (new Date(value).toISOString() !== value) {
      invalid();
    }
  } catch {
    invalid();
  }
  return value;
}

export function createToolExecutionRepository(db: DatabaseSync): ToolExecutionRepository {
  return {
    start(record: ToolExecutionStart): void {
      const id = requireNonEmptyString(record.id);
      const traceId = requireNonEmptyString(record.traceId);
      const actor = requireNonEmptyString(record.actor);
      const toolName = requireNonEmptyString(record.toolName);
      const toolVersion = requirePositiveInteger(record.toolVersion);
      const startedAt = requireCanonicalIso(record.startedAt);
      const projectId =
        record.projectId === undefined ? null : requireNonEmptyString(record.projectId);
      const inputSummary = sanitizeSummary(record.inputSummary);
      try {
        db.prepare(
          "INSERT INTO tool_executions(id, trace_id, project_id, actor, tool_name, tool_version, status, input_summary_json, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)",
        ).run(id, traceId, projectId, actor, toolName, toolVersion, inputSummary ?? null, startedAt);
      } catch (error) {
        if ((error as Error).message.includes("UNIQUE constraint failed")) {
          throw new ToolExecutionError("duplicate", "tool execution already exists");
        }
        throw new ToolExecutionError("persistence", "failed to persist tool execution start");
      }
    },

    finish(record: ToolExecutionFinish): void {
      const id = requireNonEmptyString(record.id);
      if (!TERMINAL_STATUSES.includes(record.status)) {
        invalid();
      }
      const attempts = requireNonNegativeInteger(record.attempts);
      const retries = requireNonNegativeInteger(record.retries);
      const bytesReceived = requireNonNegativeInteger(record.bytesReceived);
      const resultCount = requireNonNegativeInteger(record.resultCount);
      const finishedAt = requireCanonicalIso(record.finishedAt);
      const durationMs =
        record.durationMs === undefined ? null : requireNonNegativeInteger(record.durationMs);
      let errorCode: string | null = null;
      if (record.errorCode !== undefined) {
        if (!TOOL_FAILURE_CODES.has(record.errorCode)) {
          invalid();
        }
        errorCode = record.errorCode;
      }
      // status ↔ errorCode consistency (validated before any write):
      // completed requires no error_code, failed requires one, cancelled allows either.
      if (record.status === "completed" && errorCode !== null) {
        invalid();
      }
      if (record.status === "failed" && errorCode === null) {
        invalid();
      }
      const outputSummary = sanitizeSummary(record.outputSummary);
      try {
        const result = db
          .prepare(
            "UPDATE tool_executions SET status = ?, output_summary_json = ?, error_code = ?, attempts = ?, retries = ?, bytes_received = ?, result_count = ?, finished_at = ?, duration_ms = ? WHERE id = ? AND status = 'running'",
          )
          .run(
            record.status,
            outputSummary ?? null,
            errorCode,
            attempts,
            retries,
            bytesReceived,
            resultCount,
            finishedAt,
            durationMs,
            id,
          );
        if (result.changes !== 1) {
          if (db.prepare("SELECT id FROM tool_executions WHERE id = ?").get(id) === undefined) {
            throw new ToolExecutionError("not_found", "tool execution not found");
          }
          throw new ToolExecutionError("already_finished", "tool execution already finished");
        }
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        throw new ToolExecutionError("persistence", "failed to persist tool execution finish");
      }
    },

    getById(id: string): ToolExecution | undefined {
      try {
        const row = db
          .prepare("SELECT * FROM tool_executions WHERE id = ?")
          .get(requireNonEmptyString(id)) as ToolExecutionRow | undefined;
        return row === undefined ? undefined : rowToExecution(row);
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        throw new ToolExecutionError("persistence", "failed to read tool execution");
      }
    },

    listRecent(limit: number): ToolExecution[] {
      try {
        const rows = db
          .prepare("SELECT * FROM tool_executions ORDER BY started_at DESC, id DESC LIMIT ?")
          .all(requirePositiveInteger(limit)) as unknown as ToolExecutionRow[];
        return rows.map(rowToExecution);
      } catch (error) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        throw new ToolExecutionError("persistence", "failed to list tool executions");
      }
    },
  };
}
