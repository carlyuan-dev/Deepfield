import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { readTraceTimeline } from "../../apps/desktop/src/main/trace-store.ts";
import { parseUsageAttempt } from "../../packages/base/src/usage/contracts.ts";

/** Read-only connections only: missing files/tables never trigger migrations. */
export function exportTrace(tracePath: string, rootTraceId: string, usagePath?: string) {
  const trace = new DatabaseSync(tracePath, { readOnly: true });
  try {
    const timeline = readTraceTimeline(trace, rootTraceId);
    const related: ReturnType<typeof readTraceTimeline>[] = [];
    const seen = new Set([rootTraceId]);
    const pending = [timeline];
    let eventCount = timeline.events.length;
    let truncated = eventCount >= 10000;
    const missingRoots: string[] = [];
    // Traverse explicit relations in both directions, never by a shared batch ID.
    // Both roots and events are bounded even for cycles or long retry histories.
    while (pending.length) {
      const current = pending.shift()!;
      const inbound = trace.prepare("SELECT DISTINCT root_id FROM trace_events WHERE EXISTS (SELECT 1 FROM json_each(trace_events.payload,'$.links') link WHERE json_extract(link.value,'$.rootTraceId')=?) LIMIT 65").all(current.rootTraceId) as { root_id: string }[];
      if (inbound.length === 65) truncated = true;
      const roots = [...current.events.flatMap(event => (event.links ?? []).map(link => link.rootTraceId)), ...inbound.map(row => row.root_id)];
      for (const linkedRoot of roots) {
        if (seen.has(linkedRoot)) continue;
        if (seen.size >= 64 || eventCount >= 10000) { truncated = true; continue; }
        seen.add(linkedRoot);
        const next = readTraceTimeline(trace, linkedRoot, null, 10000 - eventCount);
        eventCount += next.events.length;
        if (eventCount >= 10000) truncated = true;
        if (!next.events.length) missingRoots.push(linkedRoot);
        related.push(next); pending.push(next);
      }
    }
    const timelines = [timeline, ...related];
    const observedTargets = new Set(timelines.flatMap(item => item.spans.map(span => `${item.rootTraceId}:${span.spanId}`)));
    const missingTargets = new Set(timelines.flatMap(item => item.events.flatMap(event => (event.links ?? [])
      .filter(link => !observedTargets.has(`${link.rootTraceId}:${link.spanId}`)).map(link => `${link.rootTraceId}:${link.spanId}`))));
    const usageAttemptIds = [...new Set([timeline, ...related].flatMap(item => item.usageAttemptIds))];
    let usage: DatabaseSync | undefined;
    try { if (usagePath) usage = new DatabaseSync(usagePath, { readOnly: true }); } catch { /* Explicit missing coverage below. */ }
    try {
      const attempts = usageAttemptIds.map(attemptId => {
        try {
          const row = usage?.prepare("SELECT data_json FROM usage_attempts WHERE attempt_id=?").get(attemptId) as { data_json: string } | undefined;
          if (!row) return { attemptId, status: "missing" as const };
          const value = parseUsageAttempt(JSON.parse(row.data_json));
          if (value.attemptId !== attemptId) throw new Error("usage_identity_mismatch");
          // Project just counters and safe enums. Profile labels and arbitrary error text are excluded.
          return { attemptId, status: "available" as const, serviceKind: value.serviceKind, outcome: value.outcome,
            providerId: /^[A-Za-z0-9][A-Za-z0-9_.:@+~-]{0,199}$/.test(value.providerId) ? value.providerId : null,
            modelId: value.modelId && /^[A-Za-z0-9][A-Za-z0-9_.:/@+~-]{0,199}$/.test(value.modelId) ? value.modelId : null,
            errorCode: value.errorCode && (/^http_[1-5][0-9]{2}$/.test(value.errorCode) || ["cancelled", "network_failed", "stream_failed", "provider_failed", "interrupted"].includes(value.errorCode)) ? value.errorCode : null,
            inputTokens: value.inputTokens, outputTokens: value.outputTokens, cacheReadTokens: value.cacheReadTokens,
            cacheWriteTokens: value.cacheWriteTokens, totalTokens: value.totalTokens, resultCount: value.resultCount,
            usageStatus: value.usageStatus, attemptCountStatus: value.attemptCountStatus };
        } catch { return { attemptId, status: "missing" as const }; }
      });
      return { ...timeline, related, associations: { status: truncated || missingRoots.length || missingTargets.size || timelines.some(item => item.coverage.status !== "observed") ? "partial" : "observed", truncated, missingRoots, missingTargetCount: missingTargets.size, rootLimit: 64, eventLimit: 10000 },
        usageAttemptIds, usage: { status: attempts.some(attempt => attempt.status === "missing") ? "partial" : usage ? "available" : "missing", attempts } };
    } finally { usage?.close(); }
  } finally { trace.close(); }
}

export function listTraces(tracePath: string) {
  const database = new DatabaseSync(tracePath, { readOnly: true });
  try {
    const rows = database.prepare("SELECT root_id FROM trace_events GROUP BY root_id ORDER BY MAX(time) DESC LIMIT 50").all() as { root_id: string }[];
    return rows.map(row => {
      const timeline = readTraceTimeline(database, row.root_id);
      const root = timeline.spans.find(span => span.start && !span.start.parentSpanId);
      return { rootTraceId: row.root_id, requestId: root?.start?.requestId ?? root?.end?.requestId ?? null,
        startedAt: root?.start?.time ?? null, finishedAt: root?.end?.time ?? null, status: root?.status ?? "unknown", coverage: timeline.coverage.status };
    });
  } finally { database.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tracePath, rootTraceId, usagePath] = process.argv.slice(2);
  if (!tracePath || !rootTraceId) { console.error("Usage: npm run trace:export -- <trace.sqlite> <rootTraceId|--list> [deepfield.sqlite]"); process.exitCode = 1; }
  else {
    try { console.log(JSON.stringify(rootTraceId === "--list" ? listTraces(tracePath) : exportTrace(tracePath, rootTraceId, usagePath), null, 2)); }
    catch { console.error("trace_export_failed: check the existing file, root ID and schema"); process.exitCode = 1; }
  }
}
