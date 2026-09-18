import type { DatabaseSync } from "node:sqlite";
import { assertSameUsageIdentity, normalizeUsageMetrics, parseUsageAttempt, validateUtc, validateDeliveryHealth, type UsageAttempt, type UsageHealth, type UsageRepository } from "@deepfield/base/usage";

export function createUsageRepository(db: DatabaseSync): UsageRepository {
  function getHealth(): UsageHealth {
    const row = db.prepare("SELECT data_json FROM usage_health WHERE id = 1").get() as { data_json: string } | undefined;
    if (!row) throw new Error("usage_not_initialized");
    const health = JSON.parse(row.data_json) as UsageHealth;
    return { ...health, degraded: health.previousUncleanShutdown || health.interruptedRequests > 0 || health.pendingRecords > 0 || health.failedRecords > 0 || health.droppedRecords > 0 || health.lastErrorCode !== null };
  }
  function saveHealth(health: UsageHealth): void {
    db.prepare("INSERT INTO usage_health(id, data_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json").run(JSON.stringify(health));
  }
  function save(record: UsageAttempt): void {
    db.prepare(`INSERT INTO usage_attempts(attempt_id, started_at, service_kind, profile_id, outcome, revision, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET outcome = excluded.outcome, revision = excluded.revision, data_json = excluded.data_json`)
      .run(record.attemptId, record.startedAt, record.serviceKind, record.profileId ?? null, record.outcome, record.revision, JSON.stringify(record));
  }
  return {
    initialize(now) {
      validateUtc(now);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare("SELECT 1 FROM usage_health WHERE id = 1").get();
        const health: UsageHealth = existing ? getHealth() : {
          collectionStartedAt: now, lastInitializedAt: now, cleanShutdown: true, previousUncleanShutdown: false,
          interruptedRequests: 0, pendingRecords: 0, failedRecords: 0, droppedRecords: 0, lastErrorCode: null, degraded: false,
        };
        const running = db.prepare("SELECT data_json FROM usage_attempts WHERE outcome = 'running'").all() as { data_json: string }[];
        for (const row of running) {
          const record = parseUsageAttempt(JSON.parse(row.data_json));
          const finishedAt = now < record.startedAt ? record.startedAt : now;
          save(parseUsageAttempt({ ...record, outcome: "interrupted", finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(record.startedAt)), revision: record.revision + 1 }));
        }
        saveHealth({ ...health, lastInitializedAt: now, previousUncleanShutdown: !health.cleanShutdown, cleanShutdown: false, interruptedRequests: health.interruptedRequests + running.length });
        db.exec("COMMIT"); return getHealth();
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    upsert(input) {
      getHealth();
      const record = parseUsageAttempt(input);
      const row = db.prepare("SELECT data_json FROM usage_attempts WHERE attempt_id = ?").get(record.attemptId) as { data_json: string } | undefined;
      if (row) {
        const previous = parseUsageAttempt(JSON.parse(row.data_json));
        assertSameUsageIdentity(previous, record);
        if (record.revision <= previous.revision || (previous.outcome !== "running" && record.outcome === "running")) return "ignored";
        // A missing final metric must not erase earlier measured usage. Known
        // cumulative counters replace prior values; they are never added together.
        const merged = {
          inputTokens: record.inputTokens ?? previous.inputTokens,
          outputTokens: record.outputTokens ?? previous.outputTokens,
          cacheReadTokens: record.cacheReadTokens ?? previous.cacheReadTokens,
          cacheWriteTokens: record.cacheWriteTokens ?? previous.cacheWriteTokens,
          totalTokens: record.totalTokens ?? previous.totalTokens,
        };
        // The latest explicit total is authoritative. If filling missing fields
        // from an older revision would contradict it, keep only the new snapshot
        // instead of deriving a stale total or guessing which component changed.
        const conflictsWithTotal = record.totalTokens !== null && merged.inputTokens !== null && merged.outputTokens !== null
          && merged.inputTokens + merged.outputTokens !== record.totalTokens;
        const metrics = normalizeUsageMetrics(conflictsWithTotal ? record : merged);
        save(parseUsageAttempt({ ...record, ...metrics, resultCount: record.resultCount ?? previous.resultCount,
          attemptCountStatus: previous.attemptCountStatus === "incomplete" ? "incomplete" : record.attemptCountStatus }));
        return "updated";
      }
      save(record); return "inserted";
    },
    readRange(query) {
      validateUtc(query.from); validateUtc(query.to);
      const rows = db.prepare("SELECT data_json FROM usage_attempts WHERE service_kind = ? AND started_at >= ? AND started_at < ? ORDER BY started_at, attempt_id").all(query.serviceKind, query.from, query.to) as { data_json: string }[];
      return rows.map((row) => parseUsageAttempt(JSON.parse(row.data_json)));
    },
    getHealth,
    setDeliveryHealth(patch) { validateDeliveryHealth(patch); saveHealth({ ...getHealth(), ...patch }); },
    markCleanShutdown() { saveHealth({ ...getHealth(), cleanShutdown: true }); },
  };
}
