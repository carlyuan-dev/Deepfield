import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createUsageService, createUsageQueryService } from "@deepfield/base/usage";
import { migrate } from "./migrations.js";
import { createUsageRepository } from "./usage-repository.js";

const handles: DatabaseSync[] = [];
const attempt = {
  attemptId: "a", operationId: "op", sourceId: "chat", serviceKind: "llm" as const,
  profileId: "p1", profileName: "First", providerId: "provider", modelId: "model",
  configRevisionId: "config-1", startedAt: "2026-09-18T00:00:00.000Z",
  finishedAt: "2026-09-18T00:00:01.000Z", outcome: "succeeded" as const,
  durationMs: 1000, revision: 2, attemptCountStatus: "complete" as const, errorCode: null,
  inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: null,
  totalTokens: 120, usageStatus: "reported" as const, resultCount: null,
};
function setup() {
  const db = new DatabaseSync(":memory:"); handles.push(db); migrate(db);
  const repo = createUsageRepository(db);
  repo.initialize("2026-09-01T00:00:00.000Z");
  return { db, repo, service: createUsageService(repo), query: createUsageQueryService(repo, () => new Date("2026-09-18T12:00:00.000Z")) };
}
afterEach(() => handles.splice(0).forEach((db) => db.close()));
const range = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z", timeZone: "UTC", serviceKind: "llm" as const };

describe("durable usage ledger", () => {
  it.each([
    { inputTokens: null, outputTokens: null },
    { inputTokens: 110, outputTokens: null },
  ])("keeps a newer authoritative total without inventing a stale breakdown: %j", async (components) => {
    const { service, repo, query } = setup();
    expect(await service.recordStart({ ...attempt, outcome: "running", finishedAt: null, durationMs: null, revision: 1 })).toBe(true);
    expect(await service.recordFinish({ ...attempt, ...components, cacheReadTokens: null, totalTokens: 150, usageStatus: "partial" })).toBe(true);
    expect(repo.readRange(range)[0]).toMatchObject({ ...components, cacheReadTokens: null, totalTokens: 150, usageStatus: "partial", revision: 2 });
    expect(await query.getSummary(range)).toMatchObject({ requests: 1, ...components, totalTokens: 150, partialUsageRequests: 1, reportedUsageRequests: 0 });
  });
  it("preserves measured metrics when a newer cancellation has no final usage", async () => {
    const { service, repo } = setup();
    expect(await service.recordStart({ ...attempt, outcome: "running", finishedAt: null, durationMs: null, revision: 1 })).toBe(true);
    expect(await service.recordFinish({ ...attempt, outcome: "cancelled", inputTokens: null, outputTokens: null, cacheReadTokens: null, totalTokens: null, usageStatus: "unknown" })).toBe(true);
    expect(repo.readRange(range)[0]).toMatchObject({ outcome: "cancelled", inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, totalTokens: 120, usageStatus: "reported" });
  });
  it("surfaces malformed events nonfatally and preserves degradation after a later success", async () => {
    const { service, repo } = setup();
    expect(await service.recordFinish({ ...attempt, apiKey: "secret" } as typeof attempt)).toBe(false);
    expect(await service.recordFinish(attempt)).toBe(true);
    expect(repo.getHealth()).toMatchObject({ degraded: false, currentFailure: false, failedRecords: 1, lastErrorCode: null });
  });
  it("returns a negative acknowledgement for storage failure and persists a safe warning", async () => {
    const { service, repo, db } = setup();
    db.exec("DROP TABLE usage_attempts");
    expect(await service.recordFinish(attempt)).toBe(false);
    expect(repo.getHealth()).toMatchObject({ degraded: true, currentFailure: true, failedRecords: 1, lastErrorCode: "write_failed" });
  });
  it("replaces cumulative snapshots rather than adding them", async () => {
    const { service, query } = setup();
    await service.recordFinish(attempt);
    await service.recordFinish({ ...attempt, revision: 3, inputTokens: 200, totalTokens: 220 });
    expect(await query.getSummary(range)).toMatchObject({ requests: 1, inputTokens: 200, outputTokens: 20, totalTokens: 220 });
  });
  it("keeps search outcomes distinct and groups drafts without exposing profiles", async () => {
    const { service, query } = setup();
    const { modelId: _model, profileId: _profile, ...base } = attempt;
    for (const [index, outcome] of (["succeeded", "failed", "cancelled", "interrupted"] as const).entries()) {
      await service.recordFinish({ ...base, attemptId: `search-${index}`, serviceKind: "search", outcome, draftSessionId: "draft-1", resultCount: outcome === "succeeded" ? 0 : null, inputTokens: null, outputTokens: null, cacheReadTokens: null, totalTokens: null, usageStatus: "unknown" });
    }
    const dashboard = await query.getDashboard({ serviceKind: "search", range: "month", timeZone: "UTC" });
    expect(dashboard.summary).toMatchObject({ requests: 4, succeeded: 1, failed: 1, cancelled: 1, interrupted: 1, resultCount: 0, inputTokens: null, unknownUsageRequests: 0 });
    expect(dashboard.providers[0]).toMatchObject({ models: [], requests: 4 });
    expect(dashboard.providers[0]).not.toHaveProperty("profileId");
  });
  it("is migrated independently and does not cascade from business tables", () => {
    const { db, repo } = setup(); migrate(db);
    expect(db.prepare("PRAGMA foreign_key_list(usage_attempts)").all()).toEqual([]);
    repo.upsert(attempt);
    expect(repo.readRange(range)).toHaveLength(1);
  });
  it("deduplicates finish-before-start and never resurrects a finished attempt", async () => {
    const { service, repo } = setup();
    await service.recordFinish(attempt); await service.recordFinish(attempt);
    await service.recordStart({ ...attempt, outcome: "running", finishedAt: null, durationMs: null, errorCode: null, revision: 100 });
    await service.recordFinish({ ...attempt, revision: 1, outputTokens: 1, totalTokens: 101 });
    expect(repo.readRange(range)).toEqual([attempt]);
  });
  it("rejects immutable snapshot changes and preserves historical grouping", async () => {
    const { service, repo, db } = setup(); await service.recordFinish(attempt);
    for (const change of [{ modelId: "new-model" }, { profileName: "Renamed" }, { providerId: "new-provider" }, { operationId: "other" }]) {
      expect(await service.recordFinish({ ...attempt, ...change, revision: 3 })).toBe(false);
      expect(() => repo.upsert({ ...attempt, ...change, revision: 3 })).toThrow();
    }
    db.exec("DELETE FROM companies; DELETE FROM conversations;");
    expect(repo.readRange(range)[0]).toEqual(attempt);
  });
  it("recovers previous running attempts and persists health across repository recreation", async () => {
    const { repo, service, db } = setup();
    await service.recordStart({ ...attempt, outcome: "running", finishedAt: null, durationMs: null, revision: 1 });
    repo.setDeliveryHealth({ pendingRecords: 2, failedRecords: 1, lastErrorCode: "write_failed" });
    const restarted = createUsageRepository(db);
    const health = restarted.initialize("2026-09-19T00:00:00.000Z");
    expect(health).toMatchObject({ collectionStartedAt: "2026-09-01T00:00:00.000Z", previousUncleanShutdown: true, interruptedRequests: 1, failedRecords: 1, pendingRecords: 2 });
    expect(restarted.readRange(range)[0]).toMatchObject({ outcome: "interrupted", inputTokens: 100, revision: 2 });
    restarted.markCleanShutdown();
    expect(createUsageRepository(db).initialize("2026-09-20T00:00:00.000Z").previousUncleanShutdown).toBe(false);
  });
  it("enforces validation even when bypassing the service", () => {
    const { repo } = setup();
    expect(() => repo.upsert({ ...attempt, apiKey: "secret" } as typeof attempt)).toThrow();
    expect(repo.readRange(range)).toHaveLength(0);
  });
  it("deletes only snapshot-matching eligible records and preserves concurrent enrichment and new failures", () => {
    const { repo } = setup();
    const unknown = (attemptId: string, revision = 2) => ({ ...attempt, attemptId, outcome: "failed" as const, errorCode: "network_failed", revision, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, usageStatus: "unknown" as const });
    repo.upsert(unknown("delete")); repo.upsert(unknown("enriched")); repo.upsert(unknown("new"));
    repo.upsert({ ...unknown("enriched", 3), inputTokens: 7, totalTokens: 7, usageStatus: "partial" });
    expect(repo.deleteUnknownFailures([{ attemptId: "delete", revision: 2 }, { attemptId: "enriched", revision: 2 }])).toBe(1);
    expect(repo.readRange(range).map((row) => row.attemptId)).toEqual(["enriched", "new"]);
  });
  it("retains at most 1000 eligible unknown abnormal records for 30 days without touching normal rows", () => {
    const { repo } = setup();
    const unknown = (attemptId: string, finishedAt: string) => ({ ...attempt, attemptId, startedAt: finishedAt, finishedAt, durationMs: 0, outcome: "failed" as const, errorCode: "timeout", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, usageStatus: "unknown" as const });
    repo.upsert(unknown("expired", "2026-08-01T00:00:00.000Z"));
    repo.upsert({ ...attempt, attemptId: "normal-old", startedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:00:01.000Z" });
    for (let index = 0; index < 1001; index++) repo.upsert(unknown(`u-${String(index).padStart(4, "0")}`, `2026-09-${String(1 + Math.floor(index / 50)).padStart(2, "0")}T00:00:${String(index % 50).padStart(2, "0")}.000Z`));
    repo.initialize("2026-09-21T00:00:00.000Z");
    const ids = repo.readRange({ ...range, from: "2026-08-01T00:00:00.000Z" }).map((row) => row.attemptId);
    expect(ids).toHaveLength(1001); expect(ids).toContain("normal-old"); expect(ids).not.toContain("expired"); expect(ids).not.toContain("u-0000");
  });
  it("excludes known-token failures from the eligible retention scan", () => {
    const { repo, db } = setup();
    for (let index = 0; index < 1001; index++) repo.upsert({ ...attempt, attemptId: `known-${index}`, outcome: "failed", errorCode: "provider_failed", inputTokens: null, outputTokens: null, cacheReadTokens: null, totalTokens: 1, usageStatus: "partial" });
    repo.upsert({ ...attempt, attemptId: "eligible", outcome: "failed", errorCode: "timeout", inputTokens: null, outputTokens: null, cacheReadTokens: null, totalTokens: null, usageStatus: "unknown" });
    expect((db.prepare("SELECT COUNT(*) AS count FROM usage_attempts").get() as { count: number }).count).toBe(1002);
  });
  it("aggregates nullable usage and merges profiles into provider/model", async () => {
    const { query, service } = setup();
    await service.recordFinish(attempt); await service.recordFinish(attempt);
    await service.recordFinish({ ...attempt, attemptId: "b", profileId: "p2", inputTokens: null, outputTokens: null, cacheReadTokens: null, totalTokens: null, usageStatus: "unknown" });
    const summary = await query.getSummary(range);
    expect(summary).toMatchObject({ requests: 2, succeeded: 2, inputTokens: 100, totalTokens: 120, cacheReadTokens: 60, cacheWriteTokens: null, unknownUsageRequests: 1, partialUsageRequests: 0 });
    const providers = await query.getBreakdown(range);
    expect(providers).toHaveLength(1); expect(providers[0]?.models).toHaveLength(1);
    expect(providers[0]?.models[0]).toMatchObject({ modelId: "model", requests: 2 });
  });

  it("persists notice acknowledgements without changing ledger statistics and resurfaces newer history", async () => {
    const { db, repo } = setup();
    repo.upsert({ ...attempt, attemptId: "unknown-success", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, usageStatus: "unknown" });
    const query = createUsageQueryService(repo, () => new Date("2026-09-18T02:30:00.000Z"));
    const input = { serviceKind: "llm", range: "today", timeZone: "UTC" } as const;
    const before = await query.getDashboard(input);
    expect(before.unknownUsage.acknowledgeSnapshot).toEqual(["unknown-success@unknown.complete.success"]);
    expect(await query.acknowledgeUnknownUsage(before.unknownUsage.acknowledgeSnapshot)).toBe(1);
    const reopened = createUsageQueryService(createUsageRepository(db), () => new Date("2026-09-18T02:30:00.000Z"));
    const after = await reopened.getDashboard(input);
    expect(after.summary).toEqual(before.summary);
    expect(after.unknownUsage.acknowledgeSnapshot).toEqual([]);
    repo.setDeliveryHealth({ droppedRecords: 2 });
    const history = await query.getDashboard(input);
    expect(await query.acknowledgeHistoricalIssues(history.historicalNotice.fingerprint!)).toBe(true);
    expect((await reopened.getDashboard(input)).historicalNotice.fingerprint).toBeNull();
    repo.setDeliveryHealth({ droppedRecords: 3 });
    expect((await reopened.getDashboard(input)).historicalNotice.fingerprint).toBe("3:0");
  });
  it("distinguishes pre-feature days, recorded empty days and unknown tokens", async () => {
    const { query } = setup();
    const daily = await query.getDailySeries({ ...range, from: "2026-08-31T00:00:00.000Z", to: "2026-09-02T00:00:00.000Z" });
    expect(daily).toMatchObject([{ date: "2026-08-31", coverage: "untracked", requests: 0, inputTokens: null }, { date: "2026-09-01", coverage: "tracked", requests: 0, inputTokens: null }]);
  });
  it("uses start-time half-open UTC range and Shanghai natural days", async () => {
    const { service, query } = setup(); await service.recordFinish(attempt);
    expect(await query.getSummary({ ...range, to: attempt.startedAt })).toMatchObject({ requests: 0 });
    expect(await query.getSummary({ ...range, from: attempt.startedAt })).toMatchObject({ requests: 1 });
    const dashboard = await query.getDashboard({ serviceKind: "llm", range: "7d", timeZone: "Asia/Shanghai" });
    expect(dashboard).toMatchObject({ from: "2026-09-11T16:00:00.000Z", to: "2026-09-18T16:00:00.000Z", timeZone: "Asia/Shanghai" });
    expect(dashboard.daily).toHaveLength(7);
    expect(dashboard.daily[6]).toMatchObject({ date: "2026-09-18", requests: 1 });
  });
  it.each([
    ["2026-03-08T12:00:00Z", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["2026-11-01T12:00:00Z", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ])("uses DST-safe daily boundaries for %s", async (now, from, to) => {
    const { repo } = setup(); const query = createUsageQueryService(repo, () => new Date(now));
    const dashboard = await query.getDashboard({ serviceKind: "search", range: "7d", timeZone: "America/New_York" });
    expect(dashboard.to).toBe(to); expect(dashboard.daily.at(-1)).toMatchObject({ from, to });
  });
});
