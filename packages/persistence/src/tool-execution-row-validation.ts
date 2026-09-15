import { TOOL_FAILURE_CODES, ToolExecutionError } from "./tool-execution-errors.js";
import { sanitizeSummary } from "./summary-sanitizer.js";
import type { ToolExecution, ToolExecutionRow, ToolExecutionStatus } from "./types.js";

const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TERMINAL_STATUSES: readonly ToolExecutionStatus[] = ["completed", "failed", "cancelled", "skipped", "reused"];

function persistence(): never {
  throw new ToolExecutionError("persistence", "stored tool execution data is invalid");
}

// Row-specific validators: the database is an untrusted boundary, so any
// corruption here maps to persistence, never to the caller-facing
// invalid_input classification.
function rowNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    persistence();
  }
  return value;
}

function rowPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    persistence();
  }
  return value;
}

function rowNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    persistence();
  }
  return value;
}

function rowCanonicalIso(value: unknown): string {
  if (typeof value !== "string" || !CANONICAL_ISO.test(value)) {
    persistence();
  }
  try {
    if (new Date(value).toISOString() !== value) {
      persistence();
    }
  } catch {
    persistence();
  }
  return value;
}

export function validateRow(row: ToolExecutionRow): void {
  rowNonEmptyString(row.id);
  rowNonEmptyString(row.trace_id);
  if (row.project_id !== null) {
    rowNonEmptyString(row.project_id);
  }
  rowNonEmptyString(row.actor);
  rowNonEmptyString(row.tool_name);
  rowPositiveInteger(row.tool_version);
  if (row.agent_turn_index !== null) {
    rowNonNegativeInteger(row.agent_turn_index);
  }
  if (row.batch_id !== null) {
    rowNonEmptyString(row.batch_id);
  }
  if (row.tool_call_id !== null) {
    rowNonEmptyString(row.tool_call_id);
  }
  if (row.budget_consumed !== null && row.budget_consumed !== 0 && row.budget_consumed !== 1) {
    persistence();
  }
  rowNonNegativeInteger(row.attempts);
  rowNonNegativeInteger(row.retries);
  rowNonNegativeInteger(row.bytes_received);
  rowNonNegativeInteger(row.result_count);
  rowCanonicalIso(row.started_at);
  if (row.finished_at !== null) {
    rowCanonicalIso(row.finished_at);
  }
  if (row.duration_ms !== null) {
    rowNonNegativeInteger(row.duration_ms);
  }
  if (
    row.error_code !== null &&
    row.error_code !== "budget_trimmed" &&
    !TOOL_FAILURE_CODES.has(row.error_code)
  ) {
    persistence();
  }
  if (row.error_code === "budget_trimmed" && row.status !== "skipped") {
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
  // status ↔ errorCode consistency: running/completed require NULL error_code,
  // failed requires a whitelisted code, cancelled allows either.
  if (row.status === "running" && row.error_code !== null) {
    persistence();
  }
  if (row.status === "completed" && row.error_code !== null) {
    persistence();
  }
  if (row.status === "failed" && row.error_code === null) {
    persistence();
  }
  if (row.status === "skipped" && row.error_code !== "budget_trimmed") {
    persistence();
  }
  if (row.status === "reused" && row.error_code === "budget_trimmed") {
    persistence();
  }
  if (row.status === "skipped" || row.status === "reused") {
    if (
      row.agent_turn_index === null ||
      row.batch_id === null ||
      row.tool_call_id === null ||
      row.attempts !== 0 ||
      row.retries !== 0 ||
      row.bytes_received !== 0 ||
      row.result_count !== 0 ||
      row.budget_consumed !== 0 ||
      row.input_summary_json !== null ||
      row.output_summary_json !== null ||
      row.duration_ms !== null
    ) {
      persistence();
    }
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

export function rowToExecution(row: ToolExecutionRow): ToolExecution {
  validateRow(row);
  const execution: ToolExecution = {
    id: row.id,
    traceId: row.trace_id,
    ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    actor: row.actor,
    toolName: row.tool_name,
    toolVersion: row.tool_version,
    status: row.status,
    ...(row.agent_turn_index !== null ? { agentTurnIndex: row.agent_turn_index } : {}),
    ...(row.batch_id !== null ? { batchId: row.batch_id } : {}),
    ...(row.tool_call_id !== null ? { toolCallId: row.tool_call_id } : {}),
    ...(row.budget_consumed === null
      ? {}
      : { budgetConsumed: row.budget_consumed === 1 }),
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
