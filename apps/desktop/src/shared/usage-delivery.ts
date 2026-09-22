import { normalizeUsageMetrics, parseUsageAttempt, type UsageAttempt, type UsageDeliveryHealth, type UsageRecorder } from "@deepfield/base/usage";
export function createUsageDelivery(send: (value: UsageAttempt) => Promise<boolean>, options: { capacity?: number; timeoutMs?: number; retryTimeoutMs?: number; negativeAckOwnsFailure?: boolean; onHealth?: (health: UsageDeliveryHealth) => void } = {}): UsageRecorder & { health(): UsageDeliveryHealth; retry(): Promise<boolean>; flush(ms?: number): Promise<void> } {
  const state: UsageDeliveryHealth = { pendingRecords: 0, recoverableRecords: 0, failedRecords: 0, droppedRecords: 0, currentFailure: false, lastErrorCode: null };
  type Entry = { value: UsageAttempt; resolve(value: boolean): void };
  const queue: Entry[] = []; const failed = new Map<string, UsageAttempt>(); let draining = false; let closed = false; let retrying: Promise<boolean> | undefined;
  const idle = new Set<() => void>();
  function publish() { state.pendingRecords = queue.length; state.recoverableRecords = failed.size; try { options.onHealth?.({ ...state }); } catch { /* Health must remain nonfatal. */ } }
  function failure(code: string, dropped = false, countFailure = true) { if (countFailure) state.failedRecords++; if (dropped) state.droppedRecords++; state.currentFailure = true; state.lastErrorCode = code; publish(); }
  function retain(previous: UsageAttempt | undefined, next: UsageAttempt): UsageAttempt {
    if (!previous || next.revision < previous.revision || (previous.outcome !== "running" && next.outcome === "running")) return previous ?? next;
    const merged = {
      inputTokens: next.inputTokens ?? previous.inputTokens, outputTokens: next.outputTokens ?? previous.outputTokens,
      cacheReadTokens: next.cacheReadTokens ?? previous.cacheReadTokens, cacheWriteTokens: next.cacheWriteTokens ?? previous.cacheWriteTokens,
      totalTokens: next.totalTokens ?? previous.totalTokens,
    };
    const conflictsWithTotal = next.totalTokens !== null && merged.inputTokens !== null && merged.outputTokens !== null
      && merged.inputTokens + merged.outputTokens !== next.totalTokens;
    const metrics = normalizeUsageMetrics(conflictsWithTotal ? next : merged);
    return parseUsageAttempt({ ...next, ...metrics, resultCount: next.resultCount ?? previous.resultCount,
      attemptCountStatus: previous.attemptCountStatus === "incomplete" ? "incomplete" : next.attemptCountStatus });
  }
  async function sendBounded(value: UsageAttempt): Promise<boolean | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(() => send(value)).catch(() => null), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), options.timeoutMs ?? 1000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async function drain() {
    if (draining) return; draining = true;
    try {
      while (queue.length && !closed) {
        const entry = queue[0]!; const effective = retain(failed.get(entry.value.attemptId), entry.value); let ok = false; let unownedFailure = false;
        for (let attempt = 0; attempt < 3 && !closed && !ok; attempt++) {
          const acknowledgement = await sendBounded(effective);
          ok = acknowledgement === true;
          if (acknowledgement === null || (acknowledgement === false && !options.negativeAckOwnsFailure)) unownedFailure = true;
        }
        if (closed) break;
        queue.shift();
        if (!ok) {
          failed.set(entry.value.attemptId, retain(failed.get(entry.value.attemptId), effective));
          failure("write_failed", false, unownedFailure);
        } else if ((failed.get(entry.value.attemptId)?.revision ?? Number.MAX_SAFE_INTEGER) <= effective.revision) {
          failed.delete(entry.value.attemptId);
          if (failed.size === 0) { state.currentFailure = false; state.lastErrorCode = null; }
        }
        entry.resolve(ok); publish();
      }
    } finally { draining = false; if (!queue.length) { for (const resolve of idle) resolve(); idle.clear(); } }
  }
  function enqueue(value: UsageAttempt): Promise<boolean> {
    let safe: UsageAttempt;
    try { safe = parseUsageAttempt(value); } catch { failure("invalid_record", true); return Promise.resolve(false); }
    const retained = failed.get(safe.attemptId);
    if (retained) {
      failed.set(safe.attemptId, retain(retained, safe));
      publish();
      return Promise.resolve(false);
    }
    if (closed || (!retained && queue.length + failed.size >= (options.capacity ?? 256))) { failure(closed ? "delivery_closed" : "queue_full", true); return Promise.resolve(false); }
    return new Promise((resolve) => { queue.push({ value: safe, resolve }); publish(); void drain(); });
  }
  return { recordStart: enqueue, recordFinish: enqueue, health: () => ({ ...state }), async retry() {
    if (closed) return false;
    if (retrying) return retrying;
    retrying = (async () => {
      const deadline = Date.now() + (options.retryTimeoutMs ?? 3000);
      for (const [attemptId, value] of [...failed]) {
        if (Date.now() >= deadline) break;
        const ok = await sendBounded(value) === true;
        if (ok && failed.get(attemptId)?.revision === value.revision) failed.delete(attemptId);
      }
      const healthy = failed.size === 0;
      state.currentFailure = !healthy;
      state.lastErrorCode = healthy ? null : "write_failed";
      publish();
      return healthy;
    })().finally(() => { retrying = undefined; });
    return retrying;
  }, async flush(ms = 2000) {
    let timer: ReturnType<typeof setTimeout> | undefined; let resolveIdle: (() => void) | undefined;
    try {
      if (queue.length) await Promise.race([new Promise<void>((resolve) => { resolveIdle = resolve; idle.add(resolve); }), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    } finally { if (timer) clearTimeout(timer); if (resolveIdle) idle.delete(resolveIdle); }
    closed = true;
    const dropped = queue.splice(0); const unrecoverable = failed.size; failed.clear();
    if (dropped.length || unrecoverable) { state.failedRecords += dropped.length; state.droppedRecords += dropped.length + unrecoverable; state.currentFailure = true; state.lastErrorCode = "flush_timeout"; for (const entry of dropped) entry.resolve(false); }
    publish();
  } };
}
