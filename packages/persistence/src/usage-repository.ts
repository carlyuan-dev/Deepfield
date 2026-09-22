import type { DatabaseSync } from "node:sqlite";
import { assertSameUsageIdentity, normalizeUsageMetrics, parseUsageAttempt, validateUtc, validateDeliveryHealth, type UsageAttempt, type UsageDeletionRef, type UsageHealth, type UsageRepository } from "@deepfield/base/usage";

const tokenMetrics = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;
const eligible = (record: UsageAttempt): boolean => record.serviceKind === "llm" && record.outcome !== "running" && record.outcome !== "succeeded" && tokenMetrics.every((key) => record[key] === null);

export function createUsageRepository(db: DatabaseSync): UsageRepository {
  let lastCleanupAt = 0;
  let writesSinceCleanup = 0;
  function getHealth(): UsageHealth {
    const row = db.prepare("SELECT data_json FROM usage_health WHERE id = 1").get() as { data_json: string } | undefined;
    if (!row) throw new Error("usage_not_initialized");
    const stored = JSON.parse(row.data_json) as Partial<UsageHealth>;
    const health: UsageHealth = { ...stored, recoverableRecords: stored.recoverableRecords ?? 0, currentFailure: stored.currentFailure ?? false } as UsageHealth;
    return { ...health, degraded: health.currentFailure || health.pendingRecords > 0 || health.recoverableRecords > 0 };
  }
  function saveHealth(health: UsageHealth): void {
    db.prepare("INSERT INTO usage_health(id, data_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json").run(JSON.stringify(health));
  }
  function save(record: UsageAttempt): void {
    db.prepare(`INSERT INTO usage_attempts(attempt_id, started_at, service_kind, profile_id, outcome, revision, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET outcome = excluded.outcome, revision = excluded.revision, data_json = excluded.data_json`)
      .run(record.attemptId, record.startedAt, record.serviceKind, record.profileId ?? null, record.outcome, record.revision, JSON.stringify(record));
  }
  const eligibleSql = "service_kind = 'llm' AND outcome NOT IN ('running', 'succeeded') AND json_extract(data_json, '$.inputTokens') IS NULL AND json_extract(data_json, '$.outputTokens') IS NULL AND json_extract(data_json, '$.cacheReadTokens') IS NULL AND json_extract(data_json, '$.cacheWriteTokens') IS NULL AND json_extract(data_json, '$.totalTokens') IS NULL";
  function cleanup(now: string, force = false, addedEligible = false): void {
    const instant = Date.parse(now);
    writesSinceCleanup += 1;
    if (!force && !addedEligible && writesSinceCleanup < 100 && instant - lastCleanupAt < 86_400_000) return;
    const eligibleCount = Number((db.prepare(`SELECT COUNT(*) AS count FROM usage_attempts WHERE ${eligibleSql}`).get() as { count: number }).count);
    if (!force && instant - lastCleanupAt < 86_400_000 && eligibleCount <= 1000) { writesSinceCleanup = 0; return; }
    const cutoff = new Date(Date.parse(now) - 30 * 86_400_000).toISOString();
    const rows = db.prepare(`SELECT attempt_id, data_json FROM usage_attempts WHERE ${eligibleSql} ORDER BY json_extract(data_json, '$.finishedAt'), attempt_id`).all() as Array<{ attempt_id: string; data_json: string }>;
    const candidates = rows.map((row) => ({ row, record: parseUsageAttempt(JSON.parse(row.data_json)) })).filter(({ record }) => eligible(record));
    const expired = candidates.filter(({ record }) => record.finishedAt! < cutoff);
    const remaining = candidates.filter(({ record }) => record.finishedAt! >= cutoff);
    const excess = remaining.slice(0, Math.max(0, remaining.length - 1000));
    const remove = [...expired, ...excess];
    if (remove.length) {
      const statement = db.prepare("DELETE FROM usage_attempts WHERE attempt_id = ?");
      for (const { row } of remove) statement.run(row.attempt_id);
    }
    lastCleanupAt = instant;
    writesSinceCleanup = 0;
  }
  return {
    initialize(now) {
      validateUtc(now);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare("SELECT 1 FROM usage_health WHERE id = 1").get();
        const health: UsageHealth = existing ? getHealth() : {
          collectionStartedAt: now, lastInitializedAt: now, cleanShutdown: true, previousUncleanShutdown: false,
          interruptedRequests: 0, pendingRecords: 0, recoverableRecords: 0, failedRecords: 0, droppedRecords: 0, currentFailure: false, lastErrorCode: null, degraded: false,
        };
        const running = db.prepare("SELECT data_json FROM usage_attempts WHERE outcome = 'running'").all() as { data_json: string }[];
        for (const row of running) {
          const record = parseUsageAttempt(JSON.parse(row.data_json));
          const finishedAt = now < record.startedAt ? record.startedAt : now;
          save(parseUsageAttempt({ ...record, outcome: "interrupted", finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(record.startedAt)), revision: record.revision + 1 }));
        }
        cleanup(now, true);
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
        cleanup(record.finishedAt ?? record.startedAt, false, eligible(record));
        return "updated";
      }
      save(record); cleanup(record.finishedAt ?? record.startedAt, false, eligible(record)); return "inserted";
    },
    readRange(query) {
      validateUtc(query.from); validateUtc(query.to);
      const rows = db.prepare("SELECT data_json FROM usage_attempts WHERE service_kind = ? AND started_at >= ? AND started_at < ? ORDER BY started_at, attempt_id").all(query.serviceKind, query.from, query.to) as { data_json: string }[];
      return rows.map((row) => parseUsageAttempt(JSON.parse(row.data_json)));
    },
    getHealth,
    setDeliveryHealth(patch) { validateDeliveryHealth(patch); saveHealth({ ...getHealth(), ...patch }); },
    markCleanShutdown() { saveHealth({ ...getHealth(), cleanShutdown: true }); },
    probeStorage() {
      db.exec("SAVEPOINT usage_probe");
      try {
        db.prepare("SELECT data_json FROM usage_health WHERE id = 1").get();
        db.prepare("UPDATE usage_health SET data_json = data_json WHERE id = 1").run();
      } finally { db.exec("ROLLBACK TO usage_probe; RELEASE usage_probe"); }
    },
    isNoticeAcknowledged(kind, key) {
      if (kind === "unknown_usage") {
        const split = key.lastIndexOf("@");
        return split > 0 && db.prepare("SELECT 1 FROM usage_attempt_acknowledgements WHERE attempt_id = ? AND signature = ?").get(key.slice(0, split), key.slice(split + 1)) !== undefined;
      }
      const [dropped, interrupted] = key.split(":").map(Number);
      const row = db.prepare("SELECT dropped_records, interrupted_requests FROM usage_history_acknowledgement WHERE id = 1").get() as { dropped_records: number; interrupted_requests: number } | undefined;
      return !!row && row.dropped_records >= dropped! && row.interrupted_requests >= interrupted!;
    },
    acknowledgeNotices(kind, keys) {
      if (keys.length > 1000 || keys.some((key) => !key || key.length > 300)) throw new Error("invalid_usage_acknowledgement");
      if (kind === "unknown_usage") {
        const insert = db.prepare("INSERT OR IGNORE INTO usage_attempt_acknowledgements(attempt_id, signature, acknowledged_at) SELECT attempt_id, ?, ? FROM usage_attempts WHERE attempt_id = ?");
        let changed = 0; const now = new Date().toISOString();
        for (const key of keys) { const split = key.lastIndexOf("@"); if (split > 0) changed += Number(insert.run(key.slice(split + 1), now, key.slice(0, split)).changes); }
        return changed;
      }
      const [dropped, interrupted] = keys[0]!.split(":").map(Number);
      db.prepare(`INSERT INTO usage_history_acknowledgement(id, dropped_records, interrupted_requests) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET dropped_records = MAX(dropped_records, excluded.dropped_records), interrupted_requests = MAX(interrupted_requests, excluded.interrupted_requests)`).run(dropped!, interrupted!);
      return 1;
    },
    deleteUnknownFailures(snapshot: UsageDeletionRef[]) {
      if (snapshot.length > 1000 || snapshot.some((ref) => !ref.attemptId || !Number.isSafeInteger(ref.revision) || ref.revision < 0)) throw new Error("invalid_usage_deletion_snapshot");
      db.exec("BEGIN IMMEDIATE");
      try {
        let deleted = 0;
        const read = db.prepare("SELECT data_json FROM usage_attempts WHERE attempt_id = ?");
        const remove = db.prepare("DELETE FROM usage_attempts WHERE attempt_id = ? AND revision = ?");
        for (const ref of snapshot) {
          const row = read.get(ref.attemptId) as { data_json: string } | undefined;
          if (!row) continue;
          const record = parseUsageAttempt(JSON.parse(row.data_json));
          if (record.revision === ref.revision && eligible(record)) deleted += Number(remove.run(ref.attemptId, ref.revision).changes);
        }
        db.exec("COMMIT"); return deleted;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}
