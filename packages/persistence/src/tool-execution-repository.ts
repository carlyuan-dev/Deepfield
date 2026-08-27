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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const TERMINAL_STATUSES: readonly ToolExecutionStatus[] = ["completed", "failed", "cancelled"];

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

function requireIsoDate(value: unknown): string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) {
    invalid();
  }
  return value;
}

function rowToExecution(row: ToolExecutionRow): ToolExecution {
  if (row.status !== "running" && !TERMINAL_STATUSES.includes(row.status)) {
    throw new ToolExecutionError("persistence", "stored tool execution data is invalid");
  }
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
    try {
      execution.inputSummary = JSON.parse(row.input_summary_json) as unknown;
    } catch {
      throw new ToolExecutionError("persistence", "stored tool execution data is invalid");
    }
  }
  if (row.output_summary_json !== null) {
    try {
      execution.outputSummary = JSON.parse(row.output_summary_json) as unknown;
    } catch {
      throw new ToolExecutionError("persistence", "stored tool execution data is invalid");
    }
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
      const startedAt = requireIsoDate(record.startedAt);
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
      const finishedAt = requireIsoDate(record.finishedAt);
      const durationMs =
        record.durationMs === undefined ? null : requireNonNegativeInteger(record.durationMs);
      const errorCode =
        record.errorCode === undefined ? null : requireNonEmptyString(record.errorCode);
      const outputSummary = sanitizeSummary(record.outputSummary);
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
    },

    getById(id: string): ToolExecution | undefined {
      const row = db
        .prepare("SELECT * FROM tool_executions WHERE id = ?")
        .get(requireNonEmptyString(id)) as ToolExecutionRow | undefined;
      return row === undefined ? undefined : rowToExecution(row);
    },

    listRecent(limit: number): ToolExecution[] {
      const rows = db
        .prepare("SELECT * FROM tool_executions ORDER BY started_at DESC, id DESC LIMIT ?")
        .all(requirePositiveInteger(limit)) as unknown as ToolExecutionRow[];
      return rows.map(rowToExecution);
    },
  };
}
