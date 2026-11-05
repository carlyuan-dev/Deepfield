import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { parseTraceEvent, parseTraceHealth, type TraceEvent, type TraceHealth, type TraceRef, type TraceScope } from "@deepfield/base/trace";

export interface TraceStoreHealth { failed: number; dropped: number; capacityStopped: boolean; bytes: number; lastErrorCode: "storage_failed" | "invalid_event" | "capacity" | null }
export interface TraceTimeline { rootTraceId: string; events: TraceEvent[]; spans: { spanId: string; kind: string; status: string; start: TraceEvent | null; end: TraceEvent | null }[]; usageAttemptIds: string[]; timing: { executionMs: number; humanWaitMs: number; queueWaitMs: number; partial: boolean }; coverage: { status: "partial" | "observed" | "missing"; openSpans: number; interruptedSpans: number; truncatedSpans: string[]; health: TraceStoreHealth | null; delivery: TraceHealth[] } }

/** Own file only. Never opens the application's database or runs its migrations. */
export function openTraceStore(path: string, options: { maxBytes?: number; retentionMs?: number; now?: () => number } = {}) {
  const database = new DatabaseSync(path);
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  // Reserve room for deleting one whole trace in WAL, including index pages.
  const protectionBytes = Math.max(0, Math.floor((maxBytes - 128 * 1024) / 2));
  let writesSinceCleanup = 0;
  let lastCleanupAt = 0;
  let nextCapacityProbe = 0;
  const health: TraceStoreHealth = { failed: 0, dropped: 0, capacityStopped: false, bytes: 0, lastErrorCode: null };
  try {
    const version = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version !== 0 && version !== 1 && version !== 2) throw new Error("unsupported_trace_version");
    if (version === 0) database.exec("PRAGMA auto_vacuum=INCREMENTAL");
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS trace_events (event_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, span_id TEXT NOT NULL, type TEXT NOT NULL, kind TEXT, time TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS trace_root ON trace_events(root_id); CREATE TABLE IF NOT EXISTS trace_sessions (session_id TEXT PRIMARY KEY, interrupted INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS trace_health (source TEXT PRIMARY KEY, payload TEXT NOT NULL); UPDATE trace_sessions SET interrupted=1; PRAGMA user_version=1;");
    const columns = database.prepare("PRAGMA table_info(trace_events)").all() as { name: string }[];
    if (!columns.some(column => column.name === "truncated_end")) database.exec("ALTER TABLE trace_events ADD COLUMN truncated_end INTEGER NOT NULL DEFAULT 0");
    database.exec("PRAGMA user_version=2");
  } catch (error) { database.close(); throw error; }
  function bytes(): number {
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) { try { total += statSync(path + suffix).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    health.bytes = total; return total;
  }
  function checkpoint(): boolean {
    const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    bytes(); return result.busy === 0;
  }
  function reclaim() {
    if (!checkpoint()) return;
    // A full VACUUM in WAL mode can transiently duplicate the entire database.
    // Release bounded page batches and checkpoint each batch instead.
    for (let i = 0; i < 64; i++) {
      const free = Number((database.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count);
      if (free === 0) break;
      database.exec("PRAGMA incremental_vacuum(8)"); if (!checkpoint()) break;
    }
  }
  function prune() {
    writesSinceCleanup = 0; lastCleanupAt = now();
    if (!checkpoint()) return;
    const cutoff = new Date(now() - (options.retentionMs ?? 30 * 86400_000)).toISOString();
    const roots = database.prepare(`SELECT terminal.root_id, MAX(terminal.time) AS ended FROM trace_events terminal
      JOIN trace_sessions owner ON owner.session_id=json_extract(terminal.payload,'$.processSessionId')
      WHERE NOT EXISTS (
        SELECT 1 FROM trace_events active JOIN trace_sessions session ON session.session_id=json_extract(active.payload,'$.processSessionId')
        WHERE active.root_id=terminal.root_id AND active.type='span.start' AND active.truncated_end=0 AND session.interrupted=0
        AND NOT EXISTS (SELECT 1 FROM trace_events done WHERE done.root_id=active.root_id AND done.span_id=active.span_id AND done.type='span.end'))
      GROUP BY terminal.root_id
      HAVING MAX(CASE WHEN json_extract(terminal.payload,'$.parentSpanId') IS NULL AND (terminal.type='span.end' OR terminal.truncated_end=1) THEN 1 ELSE 0 END)=1
        OR (MIN(owner.interrupted)=1 AND MAX(terminal.time) < ?)
      ORDER BY ended LIMIT 100`).all(cutoff) as { root_id: string; ended: string }[];
    let removed = false;
    for (const root of roots) {
      if (root.ended >= cutoff && bytes() < protectionBytes) break;
      database.prepare("DELETE FROM trace_events WHERE root_id=?").run(root.root_id); removed = true;
    }
    if (removed) { database.exec("DELETE FROM trace_sessions WHERE session_id NOT IN (SELECT json_extract(payload,'$.processSessionId') FROM trace_events)"); reclaim(); }
  }
  function dropForCapacity(event: TraceEvent): false {
    health.dropped++; health.capacityStopped = true; health.lastErrorCode = "capacity";
    // Fixed-size metadata on an existing start row only: no unbounded end
    // payloads, new spans or fabricated success can bypass the capacity guard.
    if (event.type === "span.end") {
      if (bytes() > maxBytes - 32 * 1024 && !checkpoint()) return false;
      if (bytes() <= maxBytes - 32 * 1024) {
        database.prepare("UPDATE trace_events SET truncated_end=1 WHERE root_id=? AND span_id=? AND type='span.start' AND kind=? AND json_extract(payload,'$.requestId')=? AND truncated_end=0 AND NOT EXISTS (SELECT 1 FROM trace_events done WHERE done.root_id=trace_events.root_id AND done.span_id=trace_events.span_id AND done.type='span.end')")
          .run(event.rootTraceId, event.spanId, event.kind, event.requestId);
        bytes();
      }
    }
    return false;
  }
  return {
    record(value: unknown): boolean {
      let event: TraceEvent;
      try { event = parseTraceEvent(value); } catch { health.dropped++; health.lastErrorCode = "invalid_event"; return false; }
      try {
        if (health.capacityStopped && now() < nextCapacityProbe) return dropForCapacity(event);
        if (database.prepare("SELECT 1 FROM trace_events WHERE event_id=?").get(event.eventId)) return true;
        if (bytes() >= protectionBytes) checkpoint();
        if (++writesSinceCleanup >= 100 || now() - lastCleanupAt >= 86400_000 || bytes() >= protectionBytes) prune();
        if (bytes() >= protectionBytes) {
          reclaim();
          if (bytes() >= protectionBytes) { nextCapacityProbe = now() + 60_000; return dropForCapacity(event); }
        }
        database.prepare("INSERT OR IGNORE INTO trace_sessions(session_id) VALUES (?)").run(event.processSessionId);
        // First observed terminal is immutable, including delayed/out-of-order starts.
        if (event.type === "span.end" && database.prepare("SELECT 1 FROM trace_events WHERE root_id=? AND span_id=? AND type='span.end'").get(event.rootTraceId, event.spanId)) return true;
        database.prepare("INSERT INTO trace_events(event_id,root_id,span_id,type,kind,time,payload) VALUES (?,?,?,?,?,?,?)").run(event.eventId, event.rootTraceId, event.spanId, event.type, "kind" in event ? event.kind : null, event.time, JSON.stringify(event));
        if (event.type === "span.end") database.prepare("UPDATE trace_events SET truncated_end=0 WHERE root_id=? AND span_id=? AND truncated_end=1").run(event.rootTraceId, event.spanId);
        health.capacityStopped = false; bytes(); return true;
      } catch { health.failed++; health.lastErrorCode = "storage_failed"; return false; }
    },
    query(rootTraceId: string) { return readTraceTimeline(database, rootTraceId, { ...health }); },
    find(ref: TraceRef): TraceScope | undefined {
      const fields = { request: ["requestId", "request"], interaction: ["interactionId", "interaction"], invocation: ["invocationId", "action"], task: ["taskId", "task"], run: ["runId", "stage"] } as const;
      const mapping = fields[ref.kind];
      if (!mapping || !/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]{0,199}$/.test(ref.id)) return undefined;
      try {
        const row = database.prepare(`SELECT payload FROM trace_events WHERE type='span.start' AND kind=? AND json_extract(payload,?)=? AND COALESCE(json_extract(payload,'$.capabilityId'),'')=? ORDER BY rowid DESC LIMIT 1`)
          .get(mapping[1], `$.${mapping[0]}`, ref.id, ref.capabilityId ?? "") as { payload: string } | undefined;
        if (!row) return undefined;
        const event = parseTraceEvent(JSON.parse(row.payload));
        return { rootTraceId: event.rootTraceId, spanId: event.spanId, requestId: event.requestId };
      } catch { return undefined; }
    },
    health: () => ({ ...health }),
    deliveryHealth(source: "main" | "worker", value: TraceHealth) {
      try {
        const safe = parseTraceHealth(value);
        const row = database.prepare("SELECT payload FROM trace_health WHERE source=?").get(source) as { payload: string } | undefined;
        const previous = row ? parseTraceHealth(JSON.parse(row.payload)) : undefined;
        const retained = { ...safe, failed: Math.max(safe.failed, previous?.failed ?? 0), dropped: Math.max(safe.dropped, previous?.dropped ?? 0), lastErrorCode: safe.lastErrorCode ?? previous?.lastErrorCode ?? null };
        if (bytes() > maxBytes - 16 * 1024) database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        if (bytes() > maxBytes - 16 * 1024) return;
        database.prepare("INSERT INTO trace_health VALUES (?,?) ON CONFLICT(source) DO UPDATE SET payload=excluded.payload").run(source, JSON.stringify(retained));
      }
      catch { health.failed++; health.lastErrorCode = "storage_failed"; }
    },
    cleanup() { try { prune(); reclaim(); nextCapacityProbe = 0; } catch { health.failed++; health.lastErrorCode = "storage_failed"; } },
    close() { try { database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { database.close(); } },
  };
}

export function readTraceTimeline(database: DatabaseSync, rootTraceId: string, health: TraceStoreHealth | null = null, eventLimit = 10000): TraceTimeline {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]{0,199}$/.test(rootTraceId)) throw new Error("invalid_root_trace_id");
  const rows = database.prepare("SELECT payload FROM trace_events WHERE root_id=? ORDER BY time, rowid LIMIT ?").all(rootTraceId, eventLimit + 1) as { payload: string }[];
  const eventLimitReached = rows.length > eventLimit;
  const events = rows.slice(0, eventLimit).map(row => parseTraceEvent(JSON.parse(row.payload)));
  const columns = database.prepare("PRAGMA table_info(trace_events)").all() as { name: string }[];
  const truncatedSpans = columns.some(column => column.name === "truncated_end")
    ? [...new Set((database.prepare("SELECT span_id FROM trace_events WHERE root_id=? AND truncated_end=1").all(rootTraceId) as { span_id: string }[]).map(row => row.span_id))] : [];
  const delivery = (database.prepare("SELECT payload FROM trace_health").all() as { payload: string }[]).map(row => parseTraceHealth(JSON.parse(row.payload)));
  const deliveryGap = delivery.some(value => value.dropped || value.failed || value.pending);
  const interrupted = new Set((database.prepare("SELECT session_id FROM trace_sessions WHERE interrupted=1").all() as { session_id: string }[]).map(row => row.session_id));
  const spanMap = new Map<string, TraceTimeline["spans"][number]>();
  for (const event of events) {
    if (event.type !== "span.start" && event.type !== "span.end") continue;
    let span = spanMap.get(event.spanId);
    if (!span) { span = { spanId: event.spanId, kind: event.kind, status: "unknown", start: null, end: null }; spanMap.set(event.spanId, span); }
    if (event.type === "span.start" && !span.start) span.start = event;
    if (event.type === "span.end" && !span.end) { span.end = event; span.status = event.status; }
  }
  const spans = [...spanMap.values()];
  for (const event of events) if (event.type === "span.state") { const span = spanMap.get(event.spanId); if (span && !span.end) span.status = event.status; }
  for (const span of spans) if (!span.end && span.start && interrupted.has(span.start.processSessionId)) span.status = "interrupted";
  const openSpans = spans.filter(span => !span.end && span.status !== "interrupted" && !truncatedSpans.includes(span.spanId)).length;
  const interruptedSpans = spans.filter(span => span.status === "interrupted").length;
  const partial = eventLimitReached || !spans.some(span => span.start && !span.start.parentSpanId) || deliveryGap || openSpans > 0 || interruptedSpans > 0 || truncatedSpans.length > 0 || events.some(event => event.type === "coverage.gap") || spans.some(span => !span.start || span.status === "unknown") || !!(health && (health.failed || health.dropped));
  const intervals = { execution: [] as [number, number][], human: [] as [number, number][], queue: [] as [number, number][] };
  for (const span of spans) {
    if (!span.start || !span.end) continue;
    const start = Date.parse(span.start.time); const end = Date.parse(span.end.time);
    if (["stage", "model", "tool", "action"].includes(span.kind)) intervals.execution.push([start, end]);
    const states = events.filter((event): event is Extract<TraceEvent, { type: "span.state" }> => event.type === "span.state" && event.spanId === span.spanId);
    states.forEach((event, index) => {
      const interval: [number, number] = [Math.max(start, Date.parse(event.time)), Math.min(end, Date.parse(states[index + 1]?.time ?? span.end!.time))];
      if (event.status === "waiting" || event.status === "editing") intervals.human.push(interval);
      if (event.status === "queued" || event.status === "paused") intervals.queue.push(interval);
    });
  }
  const union = (values: [number, number][]) => { let total = 0; let until = -Infinity; for (const [start, end] of values.sort((a, b) => a[0] - b[0])) { if (end > Math.max(start, until)) total += end - Math.max(start, until); until = Math.max(until, end); } return total; };
  return { rootTraceId, events, spans, usageAttemptIds: [...new Set(events.flatMap(event => event.type === "usage.link" ? [event.usageAttemptId] : []))], timing: { executionMs: union(intervals.execution), humanWaitMs: union(intervals.human), queueWaitMs: union(intervals.queue), partial }, coverage: {
    status: events.length === 0 ? "missing" : partial ? "partial" : "observed",
    openSpans, interruptedSpans, truncatedSpans, health, delivery,
  } };
}
