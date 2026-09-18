import { expect, it, vi } from "vitest";
import { normalizeUsageMetrics, type UsageStart } from "@deepfield/base/usage";
import { createUsageDelivery } from "./usage-delivery.js";
const start: UsageStart = { attemptId: "attempt", operationId: "operation", profileId: "profile", profileName: "Profile", providerId: "openai", modelId: "model", configRevisionId: "rev", serviceKind: "llm", startedAt: "2026-09-18T00:00:00.000Z", finishedAt: null, durationMs: null, outcome: "running", revision: 1, attemptCountStatus: "complete", errorCode: null, resultCount: null, ...normalizeUsageMetrics({}) };
it("retries missing durable acknowledgements with the same attempt/revision then exposes delivery failure", async () => {
  const received: unknown[] = [];
  const delivery = createUsageDelivery(async (value) => { received.push(value); return false; });
  expect(await delivery.recordStart(start)).toBe(false);
  expect(received).toHaveLength(3);
  expect(received[0]).toEqual(received[2]);
  expect(delivery.health()).toMatchObject({ pendingRecords: 0, failedRecords: 1, droppedRecords: 1, lastErrorCode: "write_failed" });
});
it("bounds a hung transport, rejects secrets before crossing transport, and flush drops remaining records", async () => {
  vi.useFakeTimers();
  try {
    const received: unknown[] = [];
    const delivery = createUsageDelivery((value) => { received.push(value); return new Promise(() => {}); }, { capacity: 2, timeoutMs: 10 });
    const first = delivery.recordStart(start); const second = delivery.recordStart({ ...start, attemptId: "two" });
    expect(await delivery.recordStart({ ...start, attemptId: "three" })).toBe(false);
    expect(await delivery.recordStart({ ...start, apiKey: "secret" } as UsageStart)).toBe(false);
    const flush = delivery.flush(5); await vi.advanceTimersByTimeAsync(5); await flush;
    expect(await first).toBe(false); expect(await second).toBe(false);
    expect(delivery.health()).toMatchObject({ pendingRecords: 0, droppedRecords: 4 });
    expect(JSON.stringify(received)).not.toContain("secret");
  } finally { vi.useRealTimers(); }
});
it("does not recount negative acknowledgements already accounted by the durable writer", async () => {
  const delivery = createUsageDelivery(async () => false, { negativeAckOwnsFailure: true });
  expect(await delivery.recordStart(start)).toBe(false);
  expect(delivery.health()).toMatchObject({ failedRecords: 0, droppedRecords: 1, lastErrorCode: "write_failed" });
  const brokenTransport = createUsageDelivery(async () => { throw Error("lost transport"); }, { negativeAckOwnsFailure: true });
  expect(await brokenTransport.recordStart(start)).toBe(false);
  expect(brokenTransport.health()).toMatchObject({ failedRecords: 1, droppedRecords: 1 });
});
