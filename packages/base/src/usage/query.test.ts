import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { UsageDashboardQuerySchema, normalizeUsageMetrics, type UsageAttempt, type UsageDashboardQuery, type UsageHealth, type UsageRepository } from "./contracts.js";
import { createUsageQueryService } from "./query.js";

const health: UsageHealth = { collectionStartedAt: "2026-09-18T01:30:00.000Z", lastInitializedAt: "2026-09-18T01:30:00.000Z", cleanShutdown: false, previousUncleanShutdown: false, interruptedRequests: 0, pendingRecords: 0, recoverableRecords: 0, failedRecords: 0, droppedRecords: 0, currentFailure: false, lastErrorCode: null, degraded: false };
function attempt(attemptId: string, change: Partial<UsageAttempt> = {}): UsageAttempt {
  return { attemptId, operationId: "operation", serviceKind: "llm", profileName: "Profile", providerId: "alpha", modelId: "model", configRevisionId: "revision", startedAt: "2026-09-18T02:00:00.000Z", finishedAt: "2026-09-18T02:00:01.000Z", durationMs: 1000, outcome: "succeeded", revision: 2, attemptCountStatus: "complete", errorCode: null, resultCount: null, ...normalizeUsageMetrics({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10 }), ...change } as UsageAttempt;
}
function setup(records: UsageAttempt[] = [], now = "2026-09-18T02:30:00.000Z") {
  const repository: UsageRepository = {
    initialize: () => health, getHealth: () => health, upsert: () => { throw Error("read_only"); },
    readRange: ({ serviceKind, from, to }) => records.filter((record) => record.serviceKind === serviceKind && record.startedAt >= from && record.startedAt < to),
    setDeliveryHealth: () => { throw Error("read_only"); }, markCleanShutdown: () => { throw Error("read_only"); },
    probeStorage: () => {},
    deleteUnknownFailures: () => 0,
  };
  return createUsageQueryService(repository, () => new Date(now));
}
const today = { serviceKind: "llm", range: "today", timeZone: "UTC" } as const;

describe("usage chart projection", () => {
  it.each(["http_400", "timeout", "network_failed", "cancelled"])("omits running and terminal abnormal LLM requests with no token evidence (%s) from every usage projection", async (errorCode) => {
    const model = { providerId: "deepseek", modelId: "deepseek-v4-" };
    const records = [attempt("abnormal", { ...model, outcome: errorCode === "cancelled" ? "cancelled" : "failed", errorCode, ...normalizeUsageMetrics({}) }),
      attempt("running", { ...model, outcome: "running", finishedAt: null, durationMs: null, errorCode: null, ...normalizeUsageMetrics({}) }),
      attempt("zero", { ...model, outcome: "failed", errorCode, ...normalizeUsageMetrics({ inputTokens: 0, outputTokens: 0 }) })];
    const service = setup(records);
    const range = { serviceKind: "llm", from: "2026-09-18T00:00:00.000Z", to: "2026-09-19T00:00:00.000Z", timeZone: "UTC" } as const;
    expect(await service.getSummary(range)).toMatchObject({ requests: 1, failed: 1, totalTokens: 0 });
    expect(await service.getBreakdown(range)).toHaveLength(1);
    expect((await service.getDailySeries(range)).reduce((sum, point) => sum + point.requests, 0)).toBe(1);
    const dashboard = await service.getDashboard({ ...today, model });
    expect(dashboard).toMatchObject({ summary: { requests: 1 }, trend: { models: [model], selectedModel: model, summary: { requests: 1 } } });
    expect(dashboard.trend.points.reduce((sum, point) => sum + point.requests, 0)).toBe(1);
    expect(dashboard.unknownUsage.dismissibleCount).toBe(1);
    expect(records).toHaveLength(3);
    const emptyRange = await service.getDashboard({ ...today, range: "custom", startDate: "2026-09-17", endDate: "2026-09-17", model });
    expect(emptyRange.trend.selectedModel).toEqual(model);
  });

  it.each(["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const)("retains failed requests with positive %s", async (metric) => {
    const dashboard = await setup([attempt("usage", { outcome: "failed", errorCode: "http_400", ...normalizeUsageMetrics({ [metric]: 7 }) })]).getDashboard(today);
    expect(dashboard.summary).toMatchObject({ requests: 1, failed: 1, [metric]: 7 });
    expect(dashboard.trend.models).toEqual([{ providerId: "alpha", modelId: "model" }]);
  });

  it("retains unknown successes and rejected Search requests while reporting LLM activity separately", async () => {
    const records = ["timeout", "network_error", "http_429"].map((errorCode) => attempt(errorCode, { outcome: "failed", errorCode, ...normalizeUsageMetrics({}) }));
    const search = attempt("search", { serviceKind: "search", outcome: "failed", errorCode: "http_400", ...normalizeUsageMetrics({}) });
    delete search.modelId;
    records.push(attempt("success", normalizeUsageMetrics({})), attempt("running", { ...normalizeUsageMetrics({}), outcome: "running", finishedAt: null, durationMs: null }),
      search);
    const service = setup(records);
    expect((await service.getDashboard(today)).summary).toMatchObject({ requests: 1, failed: 0, succeeded: 1, running: 0 });
    expect((await service.getDashboard(today)).inFlightRequests).toBe(1);
    expect((await service.getDashboard({ ...today, serviceKind: "search" })).summary).toMatchObject({ requests: 1, failed: 1 });
  });

  it("returns a bounded revision snapshot and reason counts only for deletable abnormal unknown records", async () => {
    const records = [
      attempt("network", { outcome: "failed", errorCode: "network_failed", revision: 4, ...normalizeUsageMetrics({}) }),
      attempt("timeout", { outcome: "failed", errorCode: "timeout", revision: 3, ...normalizeUsageMetrics({}) }),
      attempt("success", normalizeUsageMetrics({})),
      attempt("known", { outcome: "failed", errorCode: "network_error", ...normalizeUsageMetrics({ totalTokens: 7 }) }),
      attempt("running", { outcome: "running", finishedAt: null, durationMs: null, ...normalizeUsageMetrics({}) }),
    ];
    const dashboard = await setup(records).getDashboard(today);
    expect(dashboard.unknownUsage).toEqual({
      dismissibleCount: 2, networkFailureCount: 1, otherFailureCount: 1, nonDismissibleCount: 1,
      partialCount: 1, incompleteAttemptCount: 0,
      snapshot: [{ attemptId: "network", revision: 4 }, { attemptId: "timeout", revision: 3 }], acknowledgeSnapshot: ["success@unknown.complete.success", "known@partial.complete.terminal"],
    });
  });

  it("offers persisted acknowledgement for incomplete Search attempt counts", async () => {
    const search = attempt("search-incomplete", { serviceKind: "search", attemptCountStatus: "incomplete", resultCount: 2, ...normalizeUsageMetrics({}) });
    delete search.modelId;
    const dashboard = await setup([search]).getDashboard({ serviceKind: "search", range: "today", timeZone: "UTC" });
    expect(dashboard.unknownUsage).toMatchObject({ incompleteAttemptCount: 1, acknowledgeSnapshot: ["search-incomplete@unknown.incomplete.success"] });
  });

  it("returns 24 local-hour columns with half-open membership, coverage and future markers", async () => {
    const dashboard = await setup([attempt("inside"), attempt("outside", { startedAt: "2026-09-19T00:00:00.000Z" })]).getDashboard(today);
    expect(dashboard).toMatchObject({ from: "2026-09-18T00:00:00.000Z", to: "2026-09-19T00:00:00.000Z", summary: { requests: 1 }, trend: { granularity: "hour" } });
    expect(dashboard.trend.points).toHaveLength(24);
    expect(dashboard.trend.points.slice(0, 4)).toMatchObject([
      { date: "2026-09-18", from: "2026-09-18T00:00:00.000Z", to: "2026-09-18T01:00:00.000Z", coverage: "untracked", requests: 0, inputTokens: null, future: false },
      { coverage: "partial", requests: 0, future: false },
      { coverage: "tracked", requests: 1, future: false },
      { coverage: "tracked", requests: 0, future: true },
    ]);
    expect(dashboard.trend.points[2]!.label).toContain("02:00");
    expect(dashboard.daily).toHaveLength(1);
  });

  it("includes both custom dates and uses daily columns for three Shanghai days", async () => {
    const dashboard = await setup().getDashboard({ serviceKind: "search", range: "custom", timeZone: "Asia/Shanghai", startDate: "2026-09-16", endDate: "2026-09-18" });
    expect(dashboard).toMatchObject({ from: "2026-09-15T16:00:00.000Z", to: "2026-09-18T16:00:00.000Z", trend: { granularity: "day", models: [], selectedModel: null } });
    expect(dashboard.trend.points.map(({ date, label }) => [date, label])).toEqual([["2026-09-16", "2026-09-16"], ["2026-09-17", "2026-09-17"], ["2026-09-18", "2026-09-18"]]);
    expect(dashboard.trend.summary).toMatchObject({ inputCacheHitTokens: null, inputCacheMissTokens: null, inputCacheUnknownTokens: null, cacheSplitUnknownRequests: 0 });
  });

  it.each([
    ["2026-03-08", "2026-03-08T12:00:00.000Z", 23, "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-11-01", "2026-11-01T12:00:00.000Z", 25, "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ])("uses real local hours for the DST day %s", async (date, now, hours, from, to) => {
    const dashboard = await setup([], now).getDashboard({ ...today, range: "custom", timeZone: "America/New_York", startDate: date, endDate: date });
    expect(dashboard).toMatchObject({ from, to, trend: { granularity: "hour" } });
    expect(dashboard.trend.points).toHaveLength(hours);
    expect(new Set(dashboard.trend.points.map((point) => point.label)).size).toBe(hours);
    expect(dashboard.trend.points.at(-1)!.to).toBe(to);
    if (hours === 25) expect(dashboard.trend.points.slice(1, 3).map((point) => point.label)).toEqual(["01:00 GMT-04:00", "01:00 GMT-05:00"]);
    else expect(dashboard.trend.points[2]!.label).toBe("03:00 GMT-04:00");
  });

  it("sums per-call cache segments without inventing misses from unknown hits or adding writes", async () => {
    const records = [attempt("known"), attempt("unknown-hit", normalizeUsageMetrics({ inputTokens: 50, outputTokens: 5 }))];
    const dashboard = await setup(records).getDashboard(today);
    const split = { requests: 2, inputTokens: 150, inputCacheHitTokens: 60, inputCacheMissTokens: 40, inputCacheUnknownTokens: 50, cacheSplitUnknownRequests: 1 };
    expect(dashboard.trend.summary).toMatchObject(split);
    expect(dashboard.trend.points[2]).toMatchObject(split);
    expect(dashboard.summary).toMatchObject({ inputTokens: 150, cacheReadTokens: 60, cacheWriteTokens: 10 });
    expect(dashboard.trend.points[0]).toMatchObject({ inputCacheHitTokens: null, inputCacheMissTokens: null, inputCacheUnknownTokens: null });
  });

  it("realigns to local clock-hour boundaries after a half-hour DST change", async () => {
    const dashboard = await setup().getDashboard({ ...today, range: "custom", timeZone: "Australia/Lord_Howe", startDate: "2026-10-04", endDate: "2026-10-04" });
    expect(dashboard.trend.points.slice(0, 5).map((point) => point.label)).toEqual(["00:00 GMT+10:30", "01:00 GMT+10:30", "02:30 GMT+11:00", "03:00 GMT+11:00", "04:00 GMT+11:00"]);
    expect(dashboard.trend.points.at(-1)!.label).toBe("23:00 GMT+11:00");
  });

  it.each([
    [{ cacheReadTokens: 8 }, { inputCacheHitTokens: 8, inputCacheMissTokens: null, inputCacheUnknownTokens: null, cacheSplitUnknownRequests: 1 }],
    [{}, { inputCacheHitTokens: null, inputCacheMissTokens: null, inputCacheUnknownTokens: null, cacheSplitUnknownRequests: 1 }],
    [{ inputTokens: 0, cacheReadTokens: 0 }, { inputCacheHitTokens: 0, inputCacheMissTokens: 0, inputCacheUnknownTokens: 0, cacheSplitUnknownRequests: 0 }],
  ])("preserves partial, absent, and explicitly zero cache reporting: %j", async (metrics, expected) => {
    const dashboard = await setup([attempt("one", normalizeUsageMetrics(metrics))]).getDashboard(today);
    expect(dashboard.trend.summary).toMatchObject(expected);
  });

  it("filters charts by provider plus model, while global totals and daily series retain every model", async () => {
    const query = setup([attempt("z", { providerId: "zeta" }), attempt("b", { modelId: "other" }), attempt("a")]);
    const global = await query.getDashboard(today);
    expect(global.trend.models).toEqual([{ providerId: "alpha", modelId: "model" }, { providerId: "alpha", modelId: "other" }, { providerId: "zeta", modelId: "model" }]);
    expect(global.trend.selectedModel).toEqual({ providerId: "alpha", modelId: "model" });
    const filtered = await query.getDashboard({ ...today, model: { providerId: "zeta", modelId: "model" } });
    expect(filtered.trend.summary.requests).toBe(1);
    expect(filtered.trend.points[2]!.requests).toBe(1);
    expect(filtered.summary.requests).toBe(3);
    expect(filtered.daily[0]!.requests).toBe(3);
    expect(filtered.providers).toEqual(global.providers);
  });

  it("retains an explicit absent identity without falling back to a populated model", async () => {
    const model = { providerId: "missing", modelId: "模型 alias (latest)" };
    const dashboard = await setup([attempt("one")]).getDashboard({ ...today, model });
    expect(dashboard.trend.selectedModel).toEqual(model);
    expect(dashboard.trend.models).toContainEqual(model);
    expect(dashboard.trend.summary.requests).toBe(0);
    expect(dashboard.trend.points.every((point) => point.requests === 0)).toBe(true);
    const empty = await setup().getDashboard(today);
    expect(empty.trend).toMatchObject({ selectedModel: null, models: [], summary: { requests: 0 } });
  });
});

describe("dashboard query validation", () => {
  it.each([
    { range: "custom" },
    { range: "custom", startDate: "2026-02-30", endDate: "2026-03-01" },
    { range: "custom", startDate: "bad", endDate: "2026-09-18" },
    { range: "custom", startDate: "2026-09-19", endDate: "2026-09-18" },
    { range: "custom", startDate: "2025-01-01", endDate: "2026-01-02" },
    { startDate: "2026-09-18", endDate: "2026-09-18" },
    { serviceKind: "search", model: { providerId: "alpha", modelId: "model" } },
    { timeZone: "invalid" },
  ])("rejects malformed or contradictory public query %j", async (change) => {
    await expect(setup().getDashboard({ ...today, ...change } as UsageDashboardQuery)).rejects.toThrow();
  });

  it("shares structural custom-date and LLM model restrictions with IPC", () => {
    expect(Value.Check(UsageDashboardQuerySchema, today)).toBe(true);
    expect(Value.Check(UsageDashboardQuerySchema, { ...today, range: "custom", startDate: "2026-09-18", endDate: "2026-09-18", model: { providerId: "alpha", modelId: "model" } })).toBe(true);
    expect(Value.Check(UsageDashboardQuerySchema, { ...today, range: "custom" })).toBe(false);
    expect(Value.Check(UsageDashboardQuerySchema, { ...today, startDate: "2026-09-18" })).toBe(false);
    expect(Value.Check(UsageDashboardQuerySchema, { ...today, serviceKind: "search", model: { providerId: "alpha", modelId: "model" } })).toBe(false);
  });

  it("accepts 366 inclusive local dates even when DST makes elapsed time longer", async () => {
    const dashboard = await setup().getDashboard({ ...today, range: "custom", timeZone: "America/New_York", startDate: "2026-03-09", endDate: "2027-03-09" });
    expect(dashboard.trend.points).toHaveLength(366);
  });
});
