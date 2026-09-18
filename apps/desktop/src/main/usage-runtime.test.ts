import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createUsageRepository, migrate } from "@deepfield/persistence";
import { normalizeUsageMetrics, type UsageStart } from "@deepfield/base/usage";
import { createMainUsageRuntime } from "./usage-runtime.js";
import type { UsageRepository } from "@deepfield/base/usage";
import { UsageDashboardSchema } from "@deepfield/contracts";
import { Value } from "typebox/value";

it("persists queue health across owners and turns a worker's unfinished attempt into interrupted", async () => {
  const db = new DatabaseSync(":memory:"); migrate(db);
  try {
    const repository = createUsageRepository(db); const runtime = createMainUsageRuntime(repository);
    runtime.worker.health("worker-1", { pendingRecords: 2, failedRecords: 1, droppedRecords: 0, lastErrorCode: "write_failed" });
    const record: UsageStart = { attemptId: "attempt", operationId: "operation", profileId: "profile", profileName: "Profile", providerId: "openai", modelId: "model", configRevisionId: "rev", serviceKind: "llm", startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, outcome: "running", revision: 2, attemptCountStatus: "complete", errorCode: null, resultCount: null, ...normalizeUsageMetrics({ inputTokens: 20, outputTokens: 1 }) };
    expect(await runtime.worker.record(record)).toBe(true);
    await runtime.workerExited();
    const dashboard = await runtime.query.getDashboard({ serviceKind: "llm", range: "month", timeZone: "UTC" });
    expect(dashboard.summary).toMatchObject({ requests: 1, interrupted: 1, inputTokens: 20 });
    expect(dashboard.health).toMatchObject({ pendingRecords: 0, droppedRecords: 2, failedRecords: 1, degraded: true });
    const finishedAt = new Date().toISOString();
    await runtime.worker.record({ ...record, attemptId: "terminal-first", revision: 2, outcome: "succeeded", finishedAt, durationMs: 0 });
    await runtime.worker.record({ ...record, attemptId: "terminal-first", revision: 99 });
    await runtime.workerExited();
    expect((await runtime.query.getDashboard({ serviceKind: "llm", range: "month", timeZone: "UTC" })).summary).toMatchObject({ requests: 2, succeeded: 1, interrupted: 1 });
    await runtime.shutdown();
    expect(repository.getHealth().cleanShutdown).toBe(true);
  } finally { db.close(); }
});
it("usage initialization/storage failure does not abort startup and exposes degraded health", async () => {
  const fail = () => { throw Error("private sqlite path"); };
  const repository: UsageRepository = { initialize: fail, upsert: fail, readRange: fail, getHealth: fail, setDeliveryHealth: fail, markCleanShutdown: fail };
  const runtime = createMainUsageRuntime(repository);
  const dashboard = await runtime.query.getDashboard({ serviceKind: "llm", range: "month", timeZone: "UTC" });
  expect(dashboard.health).toMatchObject({ degraded: true, lastErrorCode: "usage_unavailable" });
  expect(Value.Check(UsageDashboardSchema, dashboard)).toBe(true);
  const model = { providerId: "provider", modelId: "model" };
  const hourly = await runtime.query.getDashboard({ serviceKind: "llm", range: "custom", timeZone: "UTC", startDate: "2026-09-18", endDate: "2026-09-18", model });
  expect(hourly.trend).toMatchObject({ selectedModel: model, models: [model], summary: { requests: 0, inputCacheHitTokens: null, inputCacheMissTokens: null, inputCacheUnknownTokens: null } });
  expect(hourly.trend.points).toHaveLength(24);
  expect(Value.Check(UsageDashboardSchema, hourly)).toBe(true);
  expect(JSON.stringify(dashboard)).not.toContain("private sqlite path");
  await runtime.shutdown();
});

function fixtureRecord(): UsageStart {
  return { attemptId: "attempt", operationId: "operation", profileId: "profile", profileName: "Profile", providerId: "openai", modelId: "model", configRevisionId: "rev", serviceKind: "llm", startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, outcome: "running", revision: 1, attemptCountStatus: "complete", errorCode: null, resultCount: null, ...normalizeUsageMetrics({}) };
}

it("overlays retained failure/drop health when reads succeed but all writes fail", async () => {
  const db = new DatabaseSync(":memory:"); migrate(db);
  const backing = createUsageRepository(db); let readOnly = false;
  const runtime = createMainUsageRuntime({ ...backing, upsert(value) { if (readOnly) throw Error("read only"); return backing.upsert(value); }, setDeliveryHealth(value) { if (readOnly) throw Error("read only"); backing.setDeliveryHealth(value); } });
  try {
    readOnly = true;
    expect(await runtime.recorder.recordStart(fixtureRecord())).toBe(false);
    expect(backing.getHealth().failedRecords).toBe(0);
    const dashboard = await runtime.query.getDashboard({ serviceKind: "llm", range: "month", timeZone: "UTC" });
    expect(dashboard.health).toMatchObject({ degraded: true, failedRecords: 3, droppedRecords: 1, pendingRecords: 0, lastErrorCode: "health_write_failed" });
    readOnly = false;
    expect((await runtime.query.getDashboard({ serviceKind: "llm", range: "month", timeZone: "UTC" })).health.failedRecords).toBe(3);
    expect(backing.getHealth().failedRecords).toBe(3);
  } finally { await runtime.shutdown(); db.close(); }
});

it.each(["main", "worker"])("retains one durable-write failure after %s retries successfully and publishes healthy queue state", async (owner) => {
  const db = new DatabaseSync(":memory:"); migrate(db);
  const backing = createUsageRepository(db); let writes = 0;
  const runtime = createMainUsageRuntime({ ...backing, upsert(value) { if (writes++ === 0) throw Error("transient"); return backing.upsert(value); } });
  try {
    const record = fixtureRecord();
    if (owner === "main") expect(await runtime.recorder.recordStart(record)).toBe(true);
    else {
      expect(await runtime.worker.record(record)).toBe(false);
      expect(await runtime.worker.record(record)).toBe(true);
      runtime.worker.health("worker-1", { pendingRecords: 0, failedRecords: 0, droppedRecords: 0, lastErrorCode: null });
    }
    for (let index = 0; index < 2; index++) {
      const dashboard = await runtime.query.getDashboard({ serviceKind: "llm", range: "month", timeZone: "UTC" });
      expect(dashboard.summary.requests).toBe(1);
      expect(dashboard.health).toMatchObject({ degraded: true, failedRecords: 1, droppedRecords: 0, pendingRecords: 0, lastErrorCode: "write_failed" });
    }
  } finally { await runtime.shutdown(); db.close(); }
});
