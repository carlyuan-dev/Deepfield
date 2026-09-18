import { parseUsageAttempt, type UsageAttempt, type UsageDeliveryHealth, type UsageRecorder } from "@deepfield/base/usage";
export function createUsageDelivery(send: (value: UsageAttempt) => Promise<boolean>, options: { capacity?: number; timeoutMs?: number; negativeAckOwnsFailure?: boolean; onHealth?: (health: UsageDeliveryHealth) => void } = {}): UsageRecorder & { health(): UsageDeliveryHealth; flush(ms?: number): Promise<void> } {
  const state: UsageDeliveryHealth = { pendingRecords: 0, failedRecords: 0, droppedRecords: 0, lastErrorCode: null };
  type Entry = { value: UsageAttempt; resolve(value: boolean): void };
  const queue: Entry[] = []; let draining = false; let closed = false;
  const idle = new Set<() => void>();
  function publish() { state.pendingRecords = queue.length; try { options.onHealth?.({ ...state }); } catch { /* Health must remain nonfatal. */ } }
  function failure(code: string, countFailure = true) { if (countFailure) state.failedRecords++; state.droppedRecords++; state.lastErrorCode = code; publish(); }
  async function sendBounded(value: UsageAttempt): Promise<boolean | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(() => send(value)).catch(() => null), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), options.timeoutMs ?? 1000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async function drain() {
    if (draining) return; draining = true;
    try {
      while (queue.length && !closed) {
        const entry = queue[0]!; let ok = false; let unownedFailure = false;
        for (let attempt = 0; attempt < 3 && !closed && !ok; attempt++) {
          const acknowledgement = await sendBounded(entry.value);
          ok = acknowledgement === true;
          if (acknowledgement === null || (acknowledgement === false && !options.negativeAckOwnsFailure)) unownedFailure = true;
        }
        if (closed) break;
        queue.shift(); if (!ok) failure("write_failed", unownedFailure); entry.resolve(ok); publish();
      }
    } finally { draining = false; if (!queue.length) { for (const resolve of idle) resolve(); idle.clear(); } }
  }
  function enqueue(value: UsageAttempt): Promise<boolean> {
    let safe: UsageAttempt;
    try { safe = parseUsageAttempt(value); } catch { failure("invalid_record"); return Promise.resolve(false); }
    if (closed || queue.length >= (options.capacity ?? 256)) { failure(closed ? "delivery_closed" : "queue_full"); return Promise.resolve(false); }
    return new Promise((resolve) => { queue.push({ value: safe, resolve }); publish(); void drain(); });
  }
  return { recordStart: enqueue, recordFinish: enqueue, health: () => ({ ...state }), async flush(ms = 2000) {
    let timer: ReturnType<typeof setTimeout> | undefined; let resolveIdle: (() => void) | undefined;
    try {
      if (queue.length) await Promise.race([new Promise<void>((resolve) => { resolveIdle = resolve; idle.add(resolve); }), new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    } finally { if (timer) clearTimeout(timer); if (resolveIdle) idle.delete(resolveIdle); }
    closed = true;
    const dropped = queue.splice(0); if (dropped.length) { state.failedRecords += dropped.length; state.droppedRecords += dropped.length; state.lastErrorCode = "flush_timeout"; for (const entry of dropped) entry.resolve(false); }
    publish();
  } };
}
