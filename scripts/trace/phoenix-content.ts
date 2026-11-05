import { DatabaseSync } from "node:sqlite";
import { parseTraceContent, type TraceContentJson, type TraceContentRecord } from "../../packages/base/src/trace/content.ts";

const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
export interface PhoenixContentSelection {
  authorized: boolean;
  rootTraceId: string;
  records: readonly TraceContentRecord[];
}

/** No creation, migration, retention deletion, or other writes to the source store. */
export function readPhoenixContent(path: string, rootTraceId: string): TraceContentRecord[] {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version) !== 1) throw new Error();
    const size = db.prepare("SELECT count(*) n,coalesce(sum(length(CAST(payload AS BLOB))),0) bytes FROM content WHERE root_id=?").get(rootTraceId) as { n: number; bytes: number };
    if (size.n > 1000 || size.bytes > MAX_EXPORT_BYTES) throw new Error();
    const rows = db.prepare("SELECT payload FROM content WHERE root_id=? ORDER BY captured_at,rowid LIMIT 1001").all(rootTraceId) as { payload: string }[];
    if (rows.length > 1000 || rows.reduce((n, r) => n + Buffer.byteLength(r.payload), 0) > MAX_EXPORT_BYTES) throw new Error();
    const records = rows.map(row => parseTraceContent(row.payload));
    if (records.some(record => record.rootTraceId !== rootTraceId)) throw new Error();
    return records;
  } catch { throw new Error("phoenix_content_read_failed"); }
  finally { db?.close(); }
}

export function validateContentSelection(selection: PhoenixContentSelection, rootTraceId: string, project: string) {
  if (selection.authorized !== true || selection.rootTraceId !== rootTraceId || !project.startsWith("deepfield-content-") || selection.records.length > 1000) throw new Error("phoenix_content_authorization_required");
  let bytes = 0;
  const ids = new Set<string>();
  for (const record of selection.records) {
    const serialized = JSON.stringify(record); bytes += Buffer.byteLength(serialized);
    parseTraceContent(serialized);
    if (record.rootTraceId !== rootTraceId || record.captureMode !== "benchmark" || ids.has(record.contentId) || bytes > MAX_EXPORT_BYTES) throw new Error("phoenix_content_selection_invalid");
    ids.add(record.contentId);
  }
}

/** Presentation projection, never described as exact provider bytes. Stored records remain unchanged. */
export function projectPhoenixContent(record: TraceContentRecord): {
  contentId: string; kind: TraceContentRecord["kind"]; source: TraceContentRecord["source"]; capturedAt: string;
  completeness: TraceContentRecord["completeness"]; redacted: boolean; reasonCode: TraceContentRecord["reasonCode"]; byteLength: number;
  projection: "projected" | "projection_unavailable"; projectionModified?: boolean; body?: TraceContentJson;
} {
  const metadata = { contentId: record.contentId, kind: record.kind, source: record.source, capturedAt: record.capturedAt,
    completeness: record.completeness, redacted: record.redacted, reasonCode: record.reasonCode, byteLength: record.byteLength };
  if (record.completeness !== "complete") return { ...metadata, projection: "projection_unavailable" as const };
  let nodes = 0;
  let changed = false;
  function visit(value: TraceContentJson, depth: number): TraceContentJson | undefined {
    if (++nodes > 100000 || depth > 64) throw new Error();
    if (typeof value === "string" && /^[\s]*[\[{\"]/.test(value)) {
      // Serialized tool results can contain the same excluded fields. Do not
      // export an undecodable JSON-like prefix as if it had been inspected.
      const decoded = JSON.parse(value) as TraceContentJson;
      const result = visit(decoded, depth + 1); changed = true;
      return result === undefined ? undefined : JSON.stringify(result);
    }
    if (Array.isArray(value)) return value.flatMap(item => { const result = visit(item, depth + 1); return result === undefined ? [] : [result]; });
    if (value && typeof value === "object") {
      if (typeof value.type === "string" && /thinking|reasoning/i.test(value.type)) { changed = true; return undefined; }
      const result: Record<string, TraceContentJson> = Object.create(null);
      for (const [key, child] of Object.entries(value)) {
        if (/reasoning|thinking|signature/i.test(key)) { changed = true; continue; }
        if (/^(?:api[-_]?key|authorization|proxy[-_]?authorization|password|passwd|secret|access[-_]?token|refresh[-_]?token|cookie|set[-_]?cookie)$/i.test(key)) {
          result[key] = "[REDACTED]"; changed = true; continue;
        }
        const resultChild = visit(child, depth + 1); if (resultChild !== undefined) result[key] = resultChild;
      }
      return result;
    }
    return value;
  }
  try {
    const body = visit(record.body!, 0);
    return body === undefined ? { ...metadata, projection: "projection_unavailable" as const } : {
      ...metadata, projection: "projected" as const, projectionModified: changed, body,
    };
  } catch { return { ...metadata, projection: "projection_unavailable" as const }; }
}
