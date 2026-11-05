import { DatabaseSync } from "node:sqlite";
import { chmodSync, statSync } from "node:fs";
import { parseTraceContent, TRACE_CONTENT_MAX_RECORD_BYTES } from "@deepfield/base/trace";

/** Separate, local sensitive-content database. Main is the sole writer. */
export function openTraceContentStore(path: string, options: { maxBytes?: number; retentionMs?: number; now?: () => number } = {}) {
  const db = new DatabaseSync(path);
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const retention = options.retentionMs ?? 7 * 86400_000;
  const health = { dropped: 0, failed: 0, lastErrorCode: null as null | "invalid_record" | "capacity" | "storage_failed" };
  try {
    chmodSync(path, 0o600);
    const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version !== 0 && version !== 1) throw new Error("unsupported_trace_content_version");
    db.exec("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS content (id TEXT PRIMARY KEY, root_id TEXT NOT NULL, captured_at INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS content_root ON content(root_id); PRAGMA user_version=1;");
  } catch (error) { db.close(); throw error; }
  function reclaim() { for (let i = 0; i < 64; i++) { if (Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count) === 0) break; db.exec("PRAGMA incremental_vacuum(16)"); } }
  function prune() {
    // Root-level deletion avoids leaving a misleading subset from a retention eviction.
    db.prepare("DELETE FROM content WHERE root_id IN (SELECT root_id FROM content GROUP BY root_id HAVING MAX(captured_at) < ?)").run(now() - retention);
    reclaim();
  }
  try { prune(); } catch (error) { db.close(); throw error; }
  const cleanup = setInterval(() => { try { prune(); } catch { health.failed++; health.lastErrorCode = "storage_failed"; } }, Math.max(1000, Math.min(60_000, retention)));
  cleanup.unref();
  return {
    record(serialized: string): boolean {
      let record;
      try { record = parseTraceContent(serialized); } catch { health.dropped++; health.lastErrorCode = "invalid_record"; return false; }
      try {
        prune();
        // Reserve room for rollback journal and one maximum record plus indexes.
        const threshold = Math.max(0, Math.floor(maxBytes / 2) - 2 * TRACE_CONTENT_MAX_RECORD_BYTES);
        if (statSync(path).size >= threshold) { health.dropped++; health.lastErrorCode = "capacity"; return false; }
        db.prepare("INSERT OR IGNORE INTO content VALUES (?,?,?,?)").run(record.contentId, record.rootTraceId, now(), serialized);
        return true;
      } catch { health.failed++; health.lastErrorCode = "storage_failed"; return false; }
    },
    query(rootTraceId: string) {
      prune();
      const rows = db.prepare("SELECT payload FROM content WHERE root_id=? ORDER BY captured_at,rowid LIMIT 1000").all(rootTraceId) as { payload: string }[];
      return rows.map(row => parseTraceContent(row.payload));
    },
    deleteRoot(rootTraceId: string) { db.prepare("DELETE FROM content WHERE root_id=?").run(rootTraceId); reclaim(); },
    prune,
    health: () => ({ ...health }),
    close() { clearInterval(cleanup); db.close(); },
  };
}
