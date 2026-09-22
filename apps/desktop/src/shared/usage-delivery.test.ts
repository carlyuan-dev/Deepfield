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
  expect(delivery.health()).toMatchObject({ pendingRecords: 0, recoverableRecords: 1, failedRecords: 1, droppedRecords: 0, lastErrorCode: "write_failed" });
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
  expect(delivery.health()).toMatchObject({ failedRecords: 0, recoverableRecords: 1, droppedRecords: 0, lastErrorCode: "write_failed" });
  const brokenTransport = createUsageDelivery(async () => { throw Error("lost transport"); }, { negativeAckOwnsFailure: true });
  expect(await brokenTransport.recordStart(start)).toBe(false);
  expect(brokenTransport.health()).toMatchObject({ failedRecords: 1, recoverableRecords: 1, droppedRecords: 0 });
});

it("retains a bounded coalesced failed backlog and explicitly retries it without closing delivery", async () => {
  let available = false;
  const received: UsageStart[] = [];
  const delivery = createUsageDelivery(async (value) => { received.push(value as UsageStart); return available; }, { capacity: 2 });
  expect(await delivery.recordStart(start)).toBe(false);
  expect(delivery.health()).toMatchObject({ recoverableRecords: 1, droppedRecords: 0, currentFailure: true });
  expect(await delivery.recordStart({ ...start, revision: 2 })).toBe(false);
  expect(delivery.health()).toMatchObject({ recoverableRecords: 1, droppedRecords: 0 });
  expect(await delivery.recordStart({ ...start, attemptId: "two" })).toBe(false);
  expect(await delivery.recordStart({ ...start, attemptId: "three" })).toBe(false);
  expect(delivery.health()).toMatchObject({ recoverableRecords: 2, droppedRecords: 1 });
  available = true;
  expect(await delivery.retry()).toBe(true);
  expect(delivery.health()).toMatchObject({ recoverableRecords: 0, currentFailure: false, lastErrorCode: null });
  expect(await delivery.recordStart({ ...start, attemptId: "after-retry" })).toBe(true);
  expect(received.filter((value) => value.attemptId === "attempt").at(-1)?.revision).toBe(2);
});

it("merges measured metrics from a failed revision into an already queued newer terminal revision", async () => {
  let calls = 0; const sent: unknown[] = [];
  const delivery = createUsageDelivery(async (value) => { sent.push(value); return ++calls > 3; });
  const first = delivery.recordStart({ ...start, ...normalizeUsageMetrics({ inputTokens: 7 }) });
  const second = delivery.recordFinish({ ...start, revision: 2, outcome: "failed", errorCode: "timeout", finishedAt: "2026-09-18T00:00:01.000Z", durationMs: 1000, ...normalizeUsageMetrics({}) });
  expect(await first).toBe(false);
  expect(await second).toBe(true);
  expect(sent.at(-1)).toMatchObject({ revision: 2, outcome: "failed", inputTokens: 7, usageStatus: "partial" });
  expect(delivery.health()).toMatchObject({ recoverableRecords: 0, currentFailure: false });
});

it("does not let an in-flight older failure overwrite a newer retained revision", async () => {
  let calls = 0; let release!: (value: boolean) => void; let available = false; const sent: UsageStart[] = [];
  const delivery = createUsageDelivery(async (value) => {
    sent.push(value as UsageStart); calls++;
    if (calls <= 3) return false;
    if (calls === 4) return new Promise<boolean>((resolve) => { release = resolve; });
    return available;
  });
  const first = delivery.recordStart({ ...start, revision: 1, ...normalizeUsageMetrics({ inputTokens: 7 }) });
  const second = delivery.recordStart({ ...start, revision: 2, ...normalizeUsageMetrics({}) });
  expect(await first).toBe(false);
  while (!release) await Promise.resolve();
  expect(await delivery.recordStart({ ...start, revision: 3, ...normalizeUsageMetrics({ outputTokens: 4 }) })).toBe(false);
  release(false);
  expect(await second).toBe(false);
  available = true;
  expect(await delivery.retry()).toBe(true);
  expect(sent.at(-1)).toMatchObject({ revision: 3, inputTokens: 7, outputTokens: 4, totalTokens: 11 });
});
