import type { DatabaseSync } from "node:sqlite";
import type {
  ToolExecution,
  ToolExecutionFinish,
  ToolExecutionRepository,
  ToolExecutionRow,
  ToolExecutionStart,
  ToolExecutionStatus,
} from "./types.js";
import { sanitizeSummary } from "./summary-sanitizer.js";

export class ToolExecutionError extends Error {
  readonly code: "invalid_input" | "duplicate" | "not_found" | "already_finished" | "persistence";

  constructor(code: ToolExecutionError["code"], message: string) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
  }
}

/**
 * Local stable failure-code allowlist mirroring @deepfield/tool-platform's
 * public codes (alignment is asserted by tool-failure-codes.test.ts). A Set is
 * used so prototype keys like __proto__/constructor are never treated as codes.
 */
export const TOOL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "invalid_input",
  "tool_not_found",
  "tool_not_allowed",
  "permission_denied",
  "confirmation_required",
  "budget_exceeded",
  "timeout",
  "cancelled",
  "rate_limited",
  "authentication_failed",
  "network_unavailable",
  "url_blocked",
  "redirect_blocked",
  "response_too_large",
  "unsupported_content_type",
  "parse_failed",
  "invalid_output",
  "executor_failed",
  "audit_failed",
]);

// Canonical Date.toISOString() output only: YYYY-MM-DDTHH:mm:ss.sssZ.
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TERMINAL_STATUSES: readonly ToolExecutionStatus[] = ["completed", "failed", "cancelled"];

function invalid(): never {
  throw new ToolExecutionError("invalid_input", "invalid tool execution input");
}

function persistence(): never {
  throw new ToolExecutionError("persistence", "stored tool execution data is invalid");
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

/** The database is an untrusted boundary: every row field is re-validated. */
function validateRow(row: ToolExecutionRow): void {
  requireNonEmptyString(row.id);
  requireNonEmptyString(row.trace_id);
  if (row.project_id !== null) {
    requireNonEmptyString(row.project_id);
  }
  requireNonEmptyString(row.actor);
  requireNonEmptyString(row.tool_name);
  requirePositiveInteger(row.tool_version);
  requireNonNegativeInteger(row.attempts);
  requireNonNegativeInteger(row.retries);
  requireNonNegativeInteger(row.bytes_received);
  requireNonNegativeInteger(row.result_count);
  requireCanonicalIso(row.started_at);
  if (row.finished_at !== null) {
    requireCanonicalIso(row.finished_at);
  }
  if (row.duration_ms !== null) {
    requireNonNegativeInteger(row.duration_ms);
  }
  if (row.error_code !== null && !TOOL_FAILURE_CODES.has(row.error_code)) {
    persistence();
  }
  if (row.status !== "running" && !TERMINAL_STATUSES.includes(row.status)) {
    persistence();
  }
  if (row.status === "running" && row.finished_at !== null) {
    persistence();
  }
  if (row.status !== "running" && row.finished_at === null) {
    persistence();
  }
}

function parseStoredSummary(json: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    persistence();
  }
  // Re-run the same sanitizer used at write time: forbidden keys, resource
  // limits and UTF-8 budgets must hold for whatever is actually stored.
  if (sanitizeSummary(parsed) === undefined) {
    persistence();
  }
  return parsed;
}

function rowToExecution(row: ToolExecutionRow): ToolExecution {
  validateRow(row);
  const execution: ToolExecution = {
    id: row.id,
    traceId: row.trace_id,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    actor: row.actor,
    toolName: row.tool_name,
    toolVersion: row.tool_version,
    status: row.status,
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    attempts: row.attempts,
    retries: row.retries,
    bytesReceived: row.bytes_received,
    resultCount: row.result_count,
    startedAt: row.started_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
  };
  if (row.input_summary_json !== null) {
    execution.inputSummary = parseStoredSummary(row.input_summary_json);
  }
  if (row.output_summary_json !== null) {
    execution.outputSummary = parseStoredSummary(row.output_summary_json);
  }
  return execution;
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
