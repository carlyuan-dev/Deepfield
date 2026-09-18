import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createUsageRepository, migrate } from "@deepfield/persistence";
import { normalizeUsageMetrics, type UsageFinish } from "@deepfield/base/usage";
import { createToolWorkerHost } from "../main/tool-worker-host.js";
import { createMainUsageRuntime } from "../main/usage-runtime.js";
import { HostClient } from "./host-client.js";
import { createWorkerUsageRuntime } from "./usage-runtime.js";

it("retries a lost host acknowledgement without duplicating the ledger and flushes worker health", async () => {
  const db = new DatabaseSync(":memory:"); migrate(db);
  const main = createMainUsageRuntime(createUsageRepository(db)); let lost = false;
  const client = new HostClient({ timeoutMs: 10, postMessage: (value) => host.handleRequest(value) });
  const host = createToolWorkerHost({ audit: { async start() {}, async finish() {} }, secrets: { get: () => undefined }, usage: main.worker, postMessage(value) {
    if ((value as { method: string }).method === "usage.record" && !lost) { lost = true; return; }
    client.handleReply(value);
  } });
  const worker = createWorkerUsageRuntime(client);
  try {
    const now = new Date().toISOString();
    const finish: UsageFinish = { attemptId: "attempt", operationId: "op", profileId: "profile", profileName: "Search", providerId: "tavily", configRevisionId: "revision", serviceKind: "search", startedAt: now, finishedAt: now, durationMs: 0, revision: 2, outcome: "succeeded", attemptCountStatus: "complete", errorCode: null, resultCount: 0, ...normalizeUsageMetrics({}) };
    expect(await worker.recorder.recordFinish(finish)).toBe(true);
    await worker.flush();
    const dashboard = await main.query.getDashboard({ serviceKind: "search", range: "month", timeZone: "UTC" });
    expect(dashboard.summary).toMatchObject({ requests: 1, succeeded: 1 });
    expect(dashboard.health).toMatchObject({ pendingRecords: 0, droppedRecords: 0 });
  } finally { host.dispose(); client.dispose(); await main.shutdown(); db.close(); }
});
it.each([1, 3])("keeps %i writer failures across real negative Host acknowledgements without counting them twice", async (failures) => {
  const db = new DatabaseSync(":memory:"); migrate(db);
  const backing = createUsageRepository(db); let writes = 0;
  const main = createMainUsageRuntime({ ...backing, upsert(value) { if (writes++ < failures) throw Error("write unavailable"); return backing.upsert(value); } });
  const client = new HostClient({ timeoutMs: 50, postMessage: (value) => host.handleRequest(value) });
  const host = createToolWorkerHost({ audit: { async start() {}, async finish() {} }, secrets: { get: () => undefined }, usage: main.worker, postMessage: (value) => client.handleReply(value) });
  const worker = createWorkerUsageRuntime(client);
  try {
    const now = new Date().toISOString();
    const finish: UsageFinish = { attemptId: "attempt", operationId: "op", profileId: "profile", profileName: "Search", providerId: "tavily", configRevisionId: "revision", serviceKind: "search", startedAt: now, finishedAt: now, durationMs: 0, revision: 2, outcome: "succeeded", attemptCountStatus: "complete", errorCode: null, resultCount: 0, ...normalizeUsageMetrics({}) };
    expect(await worker.recorder.recordFinish(finish)).toBe(failures < 3);
    await worker.flush();
    const dashboard = await main.query.getDashboard({ serviceKind: "search", range: "month", timeZone: "UTC" });
    expect(dashboard.summary.requests).toBe(failures < 3 ? 1 : 0);
    expect(dashboard.health).toMatchObject({ pendingRecords: 0, failedRecords: failures, droppedRecords: failures < 3 ? 0 : 1, degraded: true, lastErrorCode: "write_failed" });
    await main.shutdown();
    const reopened = createMainUsageRuntime(backing);
    expect((await reopened.query.getDashboard({ serviceKind: "search", range: "month", timeZone: "UTC" })).health.failedRecords).toBe(failures);
    await reopened.shutdown();
  } finally { host.dispose(); client.dispose(); db.close(); }
});
