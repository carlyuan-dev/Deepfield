import type { TraceScope } from "./index.js";

export type TraceContentMode = "benchmark" | "diagnostic";
export type TraceContentJson = null | boolean | number | string | TraceContentJson[] | { [key: string]: TraceContentJson };
export interface TraceContentRecord extends TraceScope {
  version: 1;
  contentId: string;
  usageAttemptId?: string;
  executionId?: string;
  toolCallId?: string;
  kind: "model.request" | "model.response" | "tool.input" | "tool.output";
  source: "provider.http_json" | "pi.assistant_message" | "tool.executor";
  capturedAt: string;
  captureMode: TraceContentMode;
  body?: TraceContentJson;
  completeness: "complete" | "truncated" | "unavailable";
  redacted: boolean;
  /** UTF-8 size of the stored JSON body, after redaction/truncation. */
  byteLength: number;
  reasonCode: "none" | "size_limit" | "unsupported_body" | "serialization_failed" | "input_too_large" | "execution_failed" | "cancelled";
}
export const TRACE_CONTENT_MAX_BYTES = 256 * 1024;
export const TRACE_CONTENT_MAX_RECORD_BYTES = TRACE_CONTENT_MAX_BYTES + 4096;
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@+~-]{0,199}$/.test(value);
const fields = new Set(["version", "contentId", "rootTraceId", "spanId", "requestId", "modelRequestId", "usageAttemptId", "executionId", "toolCallId", "kind", "source", "capturedAt", "captureMode", "body", "completeness", "redacted", "byteLength", "reasonCode"]);

/** IPC accepts a bounded JSON string, never an arbitrary object or stream. */
export function parseTraceContent(serialized: string): TraceContentRecord {
  if (typeof serialized !== "string" || Buffer.byteLength(serialized) > TRACE_CONTENT_MAX_RECORD_BYTES) throw new Error("invalid_trace_content");
  const r = JSON.parse(serialized) as TraceContentRecord;
  if (!r || Array.isArray(r) || typeof r !== "object" || Object.keys(r).some(key => !fields.has(key)) || r.version !== 1 ||
      ![r.contentId, r.rootTraceId, r.spanId, r.requestId].every(id) ||
      [r.modelRequestId, r.usageAttemptId, r.executionId, r.toolCallId].some(value => value !== undefined && !id(value)) ||
      !["benchmark", "diagnostic"].includes(r.captureMode) ||
      !["complete", "truncated", "unavailable"].includes(r.completeness) || typeof r.redacted !== "boolean" ||
      !["none", "size_limit", "unsupported_body", "serialization_failed", "input_too_large", "execution_failed", "cancelled"].includes(r.reasonCode) ||
      typeof r.capturedAt !== "string" || !Number.isFinite(Date.parse(r.capturedAt)) || new Date(r.capturedAt).toISOString() !== r.capturedAt ||
      !["model.request", "model.response", "tool.input", "tool.output"].includes(r.kind) ||
      ({ "model.request": "provider.http_json", "model.response": "pi.assistant_message", "tool.input": "tool.executor", "tool.output": "tool.executor" } as Record<string, string>)[r.kind] !== r.source ||
      !Number.isSafeInteger(r.byteLength) || r.byteLength < 0 || r.byteLength > TRACE_CONTENT_MAX_BYTES ||
      r.byteLength !== (r.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(r.body))) ||
      (r.completeness === "unavailable" ? r.body !== undefined || r.reasonCode === "none" : r.body === undefined) ||
      (r.completeness === "complete" && r.reasonCode !== "none") || (r.completeness === "truncated" && r.reasonCode === "none")) throw new Error("invalid_trace_content");
  return r;
}
export interface TraceContentDraft {
  kind: TraceContentRecord["kind"];
  source: TraceContentRecord["source"];
  usageAttemptId?: string;
  executionId?: string;
  toolCallId?: string;
  modelRequestId?: string;
}
export interface TraceContentCaptureOptions {
  /** Trusted credentials only; kept in memory and never added to the record. */
  secrets?: readonly string[];
  jsonString?: boolean;
  incomplete?: "execution_failed" | "cancelled";
}
export interface TraceContentPort {
  capture(scope: TraceScope, draft: TraceContentDraft, body: () => unknown, options?: TraceContentCaptureOptions): void;
}
