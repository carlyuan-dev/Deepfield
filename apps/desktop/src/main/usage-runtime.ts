import { createUsageQueryService, createUsageService, parseUsageAttempt, validateDeliveryHealth, type UsageAttempt, type UsageStart, type UsageDeliveryHealth, type UsageHealth, type UsageRepository } from "@deepfield/base/usage";
import { createUsageDelivery } from "../shared/usage-delivery.js";
export function createMainUsageRuntime(repository: UsageRepository) {
  const startedAt = new Date().toISOString();
  let initialized = false;
  let initial: UsageHealth = { collectionStartedAt: startedAt, lastInitializedAt: startedAt, cleanShutdown: false, previousUncleanShutdown: false, interruptedRequests: 0, pendingRecords: 0, failedRecords: 1, droppedRecords: 0, lastErrorCode: "usage_unavailable", degraded: true };
  try { initial = repository.initialize(startedAt); initialized = true; } catch { /* Usage cannot abort app startup. */ }
  const empty = (): UsageDeliveryHealth => ({ pendingRecords: 0, failedRecords: 0, droppedRecords: 0, lastErrorCode: null });
  let main = empty(); let worker = empty(); let workerSession: string | undefined;
  const past = { failedRecords: initial.failedRecords, droppedRecords: initial.droppedRecords + initial.pendingRecords, lastErrorCode: initial.pendingRecords ? "previous_pending_lost" : initial.lastErrorCode };
  const writer = { failedRecords: 0, lastErrorCode: null as string | null };
  let healthWriteFailed = false;
  function ensureInitialized() {
    if (initialized) return;
    const recovered = repository.initialize(startedAt); initialized = true;
    past.failedRecords += recovered.failedRecords;
    past.droppedRecords += recovered.droppedRecords + recovered.pendingRecords;
    initial = recovered;
  }
  const active = new Map<string, UsageStart>();
  function deliveryHealth(): UsageDeliveryHealth {
    return {
      pendingRecords: main.pendingRecords + worker.pendingRecords,
      failedRecords: past.failedRecords + writer.failedRecords + main.failedRecords + worker.failedRecords,
      droppedRecords: past.droppedRecords + main.droppedRecords + worker.droppedRecords,
      lastErrorCode: healthWriteFailed ? "health_write_failed" : worker.lastErrorCode ?? main.lastErrorCode ?? writer.lastErrorCode ?? past.lastErrorCode,
    };
  }
  function overlayHealth(persisted: UsageHealth): UsageHealth {
    const retained = deliveryHealth();
    return { ...persisted, ...retained, degraded: persisted.degraded || retained.pendingRecords > 0 || retained.failedRecords > 0 || retained.droppedRecords > 0 || retained.lastErrorCode !== null };
  }
  function persistHealth() {
    try { repository.setDeliveryHealth(deliveryHealth()); }
    catch { healthWriteFailed = true; }
  }
  // Base reports every failed durable write. Route that health update through
  // one retained owner, even when the actual metadata table is unwritable.
  // Delivery queues separately own transport/validation failures and drops.
  const service = createUsageService({
    ...repository,
    upsert(value) { ensureInitialized(); return repository.upsert(value); },
    getHealth: () => overlayHealth(initial),
    setDeliveryHealth(value) {
      if (value.failedRecords !== undefined) writer.failedRecords += Math.max(0, value.failedRecords - deliveryHealth().failedRecords);
      writer.lastErrorCode = value.lastErrorCode ?? writer.lastErrorCode;
      persistHealth();
    },
  });
  const recorder = createUsageDelivery((value) => value.outcome === "running" ? service.recordStart(value) : service.recordFinish(value), { negativeAckOwnsFailure: true, onHealth(value) { main = value; persistHealth(); } });
  const query = createUsageQueryService(repository);
  async function workerExited(unexpected = false) {
    past.failedRecords += worker.failedRecords; past.droppedRecords += worker.droppedRecords + worker.pendingRecords;
    if (unexpected || worker.pendingRecords || active.size) past.lastErrorCode = "worker_interrupted";
    else past.lastErrorCode = worker.lastErrorCode ?? past.lastErrorCode;
    worker = empty(); workerSession = undefined;
    const pending: Promise<boolean>[] = [];
    for (const value of active.values()) {
      const finishedAt = new Date(Math.max(Date.now(), Date.parse(value.startedAt))).toISOString();
      pending.push(recorder.recordFinish({ ...value, revision: value.revision + 1, outcome: "interrupted", errorCode: "worker_interrupted", finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(value.startedAt) }));
    }
    active.clear(); persistHealth(); await Promise.all(pending);
  }
  return { recorder, query: { async getDashboard(input: Parameters<typeof query.getDashboard>[0]) {
    try {
      ensureInitialized(); persistHealth();
      const dashboard = await query.getDashboard(input);
      return { ...dashboard, health: overlayHealth(dashboard.health) };
    }
    catch {
      const health: UsageHealth = { ...overlayHealth(initial), degraded: true, lastErrorCode: "usage_unavailable" };
      return createUsageQueryService({ ...repository, readRange: () => [], getHealth: () => health }).getDashboard(input);
    }
  } }, worker: {
    async record(input: UsageAttempt) {
      const value = parseUsageAttempt(input);
      const ok = await (value.outcome === "running" ? service.recordStart(value) : service.recordFinish(value));
      if (ok) {
        // An acknowledged event may have been ignored (late start / stale
        // revision). Track durable state so crash recovery cannot resurrect it.
        try {
          const stored = repository.readRange({ serviceKind: value.serviceKind, from: value.startedAt, to: new Date(Date.parse(value.startedAt) + 1).toISOString(), timeZone: "UTC" }).find((row) => row.attemptId === value.attemptId);
          if (stored?.outcome === "running") active.set(stored.attemptId, stored);
          else active.delete(value.attemptId);
        } catch { past.lastErrorCode = "recovery_tracking_failed"; persistHealth(); }
      }
      return ok;
    },
    health(sessionId: string, value: UsageDeliveryHealth) {
      validateDeliveryHealth(value);
      if (workerSession && workerSession !== sessionId) void workerExited();
      workerSession = sessionId;
      worker = { ...value, failedRecords: Math.max(worker.failedRecords, value.failedRecords), droppedRecords: Math.max(worker.droppedRecords, value.droppedRecords), lastErrorCode: value.lastErrorCode ?? worker.lastErrorCode };
      persistHealth();
    },
  }, workerExited, async shutdown(workerRuntime?: { flushUsage(): Promise<boolean> }) {
    if (workerRuntime) {
      let acknowledged = false;
      try { acknowledged = await workerRuntime.flushUsage(); } catch { /* Failed transport is unconfirmed coverage. */ }
      if (!acknowledged) {
        // Main may know of no records at all. Persist the missing coverage
        // warning without inventing a failed/dropped request count.
        past.lastErrorCode = "worker_flush_unconfirmed";
        persistHealth();
      }
    }
    await workerExited();
    await recorder.flush(); persistHealth();
    try { repository.markCleanShutdown(); } catch { /* DB can already be unavailable. */ }
  } };
}
