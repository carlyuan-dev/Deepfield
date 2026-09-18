import { expect, it } from "vitest";
import { HostRequestSchema, UsageDashboardSchema } from "@deepfield/contracts";
import { Value } from "typebox/value";
import { DatabaseSync } from "node:sqlite";
import { createUsageRepository, migrate } from "@deepfield/persistence";
import { createUsageQueryService, createUsageService, normalizeUsageMetrics } from "@deepfield/base/usage";
import { HostClient } from "../worker/host-client.js";
import { createToolWorkerHost } from "./tool-worker-host.js";
import { createPreloadApi } from "../preload/preload-api.js";
import { event, FakeWebContents, makeDeps } from "./ipc-test-helpers.js";

it("validates and acknowledges usage worker writes, then serves a validated dashboard through preload IPC", async () => {
  const db = new DatabaseSync(":memory:"); migrate(db);
  const repository = createUsageRepository(db); repository.initialize("2026-09-18T00:00:00.000Z");
  const service = createUsageService(repository);
  const query = createUsageQueryService(repository, () => new Date("2026-09-18T01:00:00.000Z"));
  const client = new HostClient({ postMessage: (value) => host.handleRequest(value), timeoutMs: 50 });
  const host = createToolWorkerHost({ audit: { async start() {}, async finish() {} }, secrets: { get: () => undefined }, postMessage: (value) => client.handleReply(value), usage: { record: (value) => value.outcome === "running" ? service.recordStart(value) : service.recordFinish(value), health() {} } });
  try {
    const record = { attemptId: "search-1", operationId: "op", profileId: "profile", profileName: "Search", providerId: "tavily", configRevisionId: "revision", serviceKind: "search", startedAt: "2026-09-18T00:00:00.000Z", finishedAt: "2026-09-18T00:00:01.000Z", durationMs: 1000, revision: 2, outcome: "succeeded", attemptCountStatus: "complete", errorCode: null, resultCount: 0, ...normalizeUsageMetrics({}) };
    const envelope = { hostRequestId: "id", kind: "host.request", method: "usage.record", payload: record };
    expect(Value.Check(HostRequestSchema, envelope)).toBe(true);
    expect(Value.Check(HostRequestSchema, { ...envelope, payload: { ...record, apiKey: "secret" } })).toBe(false);
    expect(await client.request("usage.record", record)).toEqual({ acknowledged: true });
    expect(await client.request("usage.record", record)).toEqual({ acknowledged: true });
    const { ipcMain, dispose } = makeDeps({ usage: query });
    const sender = new FakeWebContents(1);
    const api = createPreloadApi({ invoke: (channel, ...args) => ipcMain.invoke(channel, event(sender), ...args), on: () => () => {} });
    const dashboard = await api.usage.getDashboard({ serviceKind: "search", range: "month", timeZone: "Asia/Shanghai" });
    expect(dashboard).toMatchObject({ summary: { requests: 1, succeeded: 1, resultCount: 0 }, providers: [{ providerId: "tavily" }] });
    const hourly = await api.usage.getDashboard({ serviceKind: "search", range: "today", timeZone: "Asia/Shanghai" });
    expect(hourly.trend.points).toHaveLength(24);
    expect(hourly.trend.points[8]).toMatchObject({ requests: 1, resultCount: 0, label: "08:00 GMT+08:00" });
    expect(hourly.trend).toMatchObject({ selectedModel: null, models: [], summary: { requests: 1 } });
    const custom = await api.usage.getDashboard({ serviceKind: "search", range: "custom", timeZone: "Asia/Shanghai", startDate: "2026-09-16", endDate: "2026-09-18" });
    expect(custom.trend.points).toHaveLength(3);
    expect(Value.Check(UsageDashboardSchema, custom)).toBe(true);
    expect(Value.Check(UsageDashboardSchema, { ...custom, trend: { ...custom.trend, summary: { ...custom.trend.summary, inputCacheMissTokens: -1 } } })).toBe(false);
    const { trend: _trend, ...legacy } = custom;
    expect(Value.Check(UsageDashboardSchema, legacy)).toBe(false);
    await expect(api.usage.getDashboard({ serviceKind: "search", range: "custom", timeZone: "UTC", startDate: "2026-02-30", endDate: "2026-03-01" })).rejects.toBeDefined();
    await expect(api.usage.getDashboard({ serviceKind: "search", range: "custom", timeZone: "UTC", startDate: "2026-09-19", endDate: "2026-09-18" })).rejects.toBeDefined();
    await expect(api.usage.getDashboard({ serviceKind: "search", range: "month", timeZone: "invalid" })).rejects.toBeDefined();
    dispose();
  } finally { host.dispose(); client.dispose(); db.close(); }
});

it("preserves stored partial cache accounting and exact model selection through preload", async () => {
  const db = new DatabaseSync(":memory:"); migrate(db);
  const repository = createUsageRepository(db); repository.initialize("2026-09-18T00:00:00.000Z");
  const service = createUsageService(repository);
  const query = createUsageQueryService(repository, () => new Date("2026-09-18T02:00:00.000Z"));
  const { ipcMain, dispose } = makeDeps({ usage: query });
  try {
    const base = { attemptId: "known", operationId: "op", profileName: "Profile", providerId: "alpha", modelId: "模型 alias", configRevisionId: "revision", serviceKind: "llm" as const, startedAt: "2026-09-18T00:00:00.000Z", finishedAt: "2026-09-18T00:00:01.000Z", durationMs: 1000, revision: 2, outcome: "succeeded" as const, attemptCountStatus: "complete" as const, errorCode: null, resultCount: null };
    expect(await service.recordFinish({ ...base, ...normalizeUsageMetrics({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10 }) })).toBe(true);
    expect(await service.recordFinish({ ...base, attemptId: "unknown-hit", ...normalizeUsageMetrics({ inputTokens: 50, outputTokens: 5 }) })).toBe(true);
    expect(await service.recordFinish({ ...base, attemptId: "other-provider", providerId: "other", ...normalizeUsageMetrics({ inputTokens: 900 }) })).toBe(true);
    const sender = new FakeWebContents(2);
    const api = createPreloadApi({ invoke: (channel, ...args) => ipcMain.invoke(channel, event(sender), ...args), on: () => () => {} });
    const dashboard = await api.usage.getDashboard({ serviceKind: "llm", range: "today", timeZone: "UTC", model: { providerId: "alpha", modelId: "模型 alias" } });
    expect(dashboard.summary).toMatchObject({ requests: 3, inputTokens: 1050 });
    expect(dashboard.trend.summary).toMatchObject({ requests: 2, inputCacheHitTokens: 60, inputCacheMissTokens: 40, inputCacheUnknownTokens: 50, cacheSplitUnknownRequests: 1 });
    expect(dashboard.trend.points[0]).toMatchObject({ requests: 2, inputCacheHitTokens: 60, inputCacheMissTokens: 40, inputCacheUnknownTokens: 50 });
    expect(dashboard.providers).toHaveLength(2);
  } finally { dispose(); db.close(); }
});
