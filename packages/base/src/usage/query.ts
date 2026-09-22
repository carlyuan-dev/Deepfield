import type { UsageAttempt, UsageSummary, UsageQuery, UsageDailyPoint, UsageProviderBreakdown, UsageHealth, UsageRepository, UsageQueryService, UsageDashboardQuery, UsageTrendSummary, UsageTrend, UsageTrendPoint, UsageModelIdentity, UsageUnknownNotice } from "./contracts.js";
import { dateAt, shiftDate, startOfDate, resolveDashboardQuery, validateUsageQuery } from "./dates.js";

const metrics = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "resultCount"] as const;
const tokenMetrics = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"] as const;
function isUsageRecord(record: UsageAttempt): boolean {
  if (record.serviceKind !== "llm") return true;
  if (record.outcome === "running") return false;
  if (record.outcome === "succeeded") return true;
  return tokenMetrics.some((key) => record[key] !== null);
}
function summarize(records: UsageAttempt[]): UsageSummary {
  const summary: UsageSummary = {
    requests: records.length, running: 0, succeeded: 0, failed: 0, cancelled: 0, interrupted: 0,
    inputTokens: null, outputTokens: null, totalTokens: null, cacheReadTokens: null, cacheWriteTokens: null, resultCount: null,
    reportedUsageRequests: 0, unknownUsageRequests: 0, partialUsageRequests: 0, incompleteAttemptCountRequests: 0,
  };
  for (const record of records) {
    summary[record.outcome]++;
    for (const key of metrics) {
      if (record[key] !== null) {
        const total = (summary[key] ?? 0) + record[key];
        if (!Number.isSafeInteger(total)) throw new Error("usage_aggregate_overflow");
        summary[key] = total;
      }
    }
    if (record.serviceKind === "llm") {
      if (record.usageStatus === "unknown") summary.unknownUsageRequests++;
      if (record.usageStatus === "partial") summary.partialUsageRequests++;
      if (record.usageStatus === "reported") summary.reportedUsageRequests++;
    }
    if (record.attemptCountStatus === "incomplete") summary.incompleteAttemptCountRequests++;
  }
  return summary;
}
const hasNoTokenMetrics = (record: UsageAttempt): boolean => tokenMetrics.every((key) => record[key] === null);
const deletableUnknown = (record: UsageAttempt): boolean => record.serviceKind === "llm" && record.outcome !== "running" && record.outcome !== "succeeded" && hasNoTokenMetrics(record);
function unknownUsageNotice(records: UsageAttempt[], repository: UsageRepository): UsageUnknownNotice {
  const unknown = records.filter((record) => record.serviceKind === "llm" && record.usageStatus === "unknown");
  const eligible = unknown.filter(deletableUnknown).slice(0, 1000);
  const signature = (record: UsageAttempt) => `${record.usageStatus}.${record.attemptCountStatus}.${record.outcome === "succeeded" ? "success" : "terminal"}`;
  const acknowledgeable = records.filter((record) => record.outcome !== "running" && !deletableUnknown(record)
    && ((record.serviceKind === "llm" && record.usageStatus !== "reported") || record.attemptCountStatus === "incomplete")
    && !repository.isNoticeAcknowledged?.("unknown_usage", `${record.attemptId}@${signature(record)}`)).slice(0, 1000);
  const networkFailureCount = eligible.filter((record) => record.errorCode === "network_failed").length;
  return { dismissibleCount: eligible.length, networkFailureCount, otherFailureCount: eligible.length - networkFailureCount,
    nonDismissibleCount: acknowledgeable.filter((record) => record.usageStatus === "unknown").length,
    partialCount: acknowledgeable.filter((record) => record.usageStatus === "partial").length,
    incompleteAttemptCount: acknowledgeable.filter((record) => record.attemptCountStatus === "incomplete").length,
    snapshot: eligible.map(({ attemptId, revision }) => ({ attemptId, revision })),
    acknowledgeSnapshot: acknowledgeable.map((record) => `${record.attemptId}@${signature(record)}`) };
}
function summarizeTrend(records: UsageAttempt[]): UsageTrendSummary {
  const result: UsageTrendSummary = { ...summarize(records), inputCacheHitTokens: null, inputCacheMissTokens: null, inputCacheUnknownTokens: null, cacheSplitUnknownRequests: 0 };
  const add = (key: "inputCacheHitTokens" | "inputCacheMissTokens" | "inputCacheUnknownTokens", value: number | null) => {
    if (value === null) return;
    const sum = (result[key] ?? 0) + value;
    if (!Number.isSafeInteger(sum)) throw new Error("usage_aggregate_overflow");
    result[key] = sum;
  };
  for (const record of records) {
    if (record.serviceKind !== "llm") continue;
    const { inputTokens: input, cacheReadTokens: hit } = record;
    add("inputCacheHitTokens", hit);
    if (input !== null && hit !== null) {
      // Cache writes are already within the non-hit input, never an extra segment.
      add("inputCacheMissTokens", input - hit);
      add("inputCacheUnknownTokens", 0);
    } else {
      result.cacheSplitUnknownRequests++;
      add("inputCacheUnknownTokens", input);
    }
  }
  return result;
}
function dailySeries(records: UsageAttempt[], query: UsageQuery, health: UsageHealth): UsageDailyPoint[] {
  const groups = new Map<string, UsageAttempt[]>();
  for (const record of records) {
    const date = dateAt(new Date(record.startedAt), query.timeZone);
    const rows = groups.get(date) ?? []; rows.push(record); groups.set(date, rows);
  }
  const result: UsageDailyPoint[] = [];
  const lastDate = dateAt(new Date(Date.parse(query.to) - 1), query.timeZone);
  for (let date = dateAt(new Date(query.from), query.timeZone); date <= lastDate; date = shiftDate(date, 1)) {
    const from = [query.from, startOfDate(date, query.timeZone)].sort()[1]!;
    const to = [query.to, startOfDate(shiftDate(date, 1), query.timeZone)].sort()[0]!;
    if (from >= to) continue; // A skipped civil date (e.g. a time-zone date-line shift).
    result.push({ date, from, to, coverage: to <= health.collectionStartedAt ? "untracked" : from < health.collectionStartedAt ? "partial" : "tracked", ...summarize(groups.get(date) ?? []) });
  }
  return result;
}
function breakdown(records: UsageAttempt[]): UsageProviderBreakdown[] {
  const providers = new Map<string, UsageAttempt[]>();
  for (const record of records) {
    const rows = providers.get(record.providerId) ?? []; rows.push(record); providers.set(record.providerId, rows);
  }
  return [...providers].map(([providerId, rows]) => {
    const models = new Map<string, UsageAttempt[]>();
    for (const row of rows) {
      if (row.serviceKind !== "llm") continue;
      const group = models.get(row.modelId!) ?? []; group.push(row); models.set(row.modelId!, group);
    }
    return { providerId, ...summarize(rows), models: [...models].map(([modelId, attempts]) => ({ modelId, ...summarize(attempts) })).sort((a, b) => b.requests - a.requests || a.modelId.localeCompare(b.modelId)) };
  }).sort((a, b) => b.requests - a.requests || a.providerId.localeCompare(b.providerId));
}

function trendSeries(records: UsageAttempt[], input: UsageDashboardQuery, query: UsageQuery, health: UsageHealth, now: Date): UsageTrend {
  const identities = new Map<string, UsageModelIdentity>();
  for (const record of records) {
    if (record.serviceKind === "llm") identities.set(JSON.stringify([record.providerId, record.modelId]), { providerId: record.providerId, modelId: record.modelId! });
  }
  let requested = input.serviceKind === "llm" ? input.model : undefined;
  if (requested) identities.set(JSON.stringify([requested.providerId, requested.modelId]), { ...requested });
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const models = [...identities.values()].sort((a, b) => compare(a.providerId, b.providerId) || compare(a.modelId, b.modelId));
  const selectedModel = requested ? { ...requested } : models[0] ?? null;
  const selected = input.serviceKind === "search" ? records : records.filter((record) => selectedModel !== null && record.providerId === selectedModel.providerId && record.modelId === selectedModel.modelId);
  const granularity = input.range === "today" || (input.range === "custom" && input.startDate === input.endDate) ? "hour" : "day";
  const points: UsageTrendPoint[] = [];
  if (granularity === "day") {
    const groups = new Map<string, UsageAttempt[]>();
    for (const record of selected) {
      const date = dateAt(new Date(record.startedAt), query.timeZone);
      const rows = groups.get(date) ?? []; rows.push(record); groups.set(date, rows);
    }
    for (const point of dailySeries(selected, query, health)) {
      points.push({ ...point, ...summarizeTrend(groups.get(point.date) ?? []), label: point.date, future: Date.parse(point.from) >= now.getTime() });
    }
  } else {
    const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: query.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" });
    const end = Date.parse(query.to);
    for (let start = Date.parse(query.from); start < end;) {
      // After a fractional-hour DST jump, make the partial hour end at the next
      // local clock hour rather than shifting every subsequent column by 30 min.
      const minute = Number(formatter.formatToParts(new Date(start)).find((part) => part.type === "minute")!.value);
      const next = Math.min(start + (60 - minute) * 60_000, end);
      const from = new Date(start).toISOString();
      const to = new Date(next).toISOString();
      points.push({ ...summarizeTrend(selected.filter((record) => record.startedAt >= from && record.startedAt < to)),
        from, to, date: dateAt(new Date(start), query.timeZone), label: formatter.format(new Date(start)), future: start >= now.getTime(),
        coverage: to <= health.collectionStartedAt ? "untracked" : from < health.collectionStartedAt ? "partial" : "tracked" });
      start = next;
    }
  }
  return { granularity, points, summary: summarizeTrend(selected), models, selectedModel };
}

export function createUsageQueryService(repository: UsageRepository, clock: () => Date = () => new Date()): UsageQueryService {
  const read = (query: UsageQuery) => {
    validateUsageQuery(query);
    const rawRecords = repository.readRange(query);
    return { rawRecords, records: rawRecords.filter(isUsageRecord) };
  };
  return {
    async getSummary(query) { return summarize(read(query).records); },
    async getDailySeries(query) { return dailySeries(read(query).records, query, repository.getHealth()); },
    async getBreakdown(query) { return breakdown(read(query).records); },
    async getHealth() { return repository.getHealth(); },
    async getDashboard(input) {
      const now = clock();
      const query = resolveDashboardQuery(input, now);
      const { records, rawRecords } = read(query); const health = repository.getHealth();
      const historyKey = `${health.droppedRecords}:${health.interruptedRequests}`;
      const historicalNotice = health.droppedRecords + health.interruptedRequests > 0 && !repository.isNoticeAcknowledged?.("historical_gap", historyKey)
        ? { droppedRecords: health.droppedRecords, interruptedRequests: health.interruptedRequests, fingerprint: historyKey }
        : { droppedRecords: 0, interruptedRequests: 0, fingerprint: null };
      return { summary: summarize(records), daily: dailySeries(records, query, health), providers: breakdown(records), trend: trendSeries(records, input, query, health, now),
        inFlightRequests: rawRecords.filter((record) => record.serviceKind === "llm" && record.outcome === "running").length,
        historicalNotice, unknownUsage: unknownUsageNotice(rawRecords, repository), health, from: query.from, to: query.to, timeZone: query.timeZone };
    },
    async deleteUnknownFailures(snapshot) { return repository.deleteUnknownFailures(snapshot); },
    async acknowledgeUnknownUsage(attemptIds) { return repository.acknowledgeNotices?.("unknown_usage", attemptIds) ?? 0; },
    async acknowledgeHistoricalIssues(fingerprint) { return (repository.acknowledgeNotices?.("historical_gap", [fingerprint]) ?? 0) > 0; },
    async repair() { repository.probeStorage(); return { repaired: true, recoveredRecords: 0, errorCode: null }; },
  };
}
