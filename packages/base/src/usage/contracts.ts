import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const Id = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:/@+~-]*$" });
const Counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Metric = Type.Union([Counter, Type.Null()]);
const Utc = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const SafeError = Type.Union([Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-zA-Z0-9_.-]+$" }), Type.Null()]);
export const UsageServiceKindSchema = Type.Union([Type.Literal("llm"), Type.Literal("search")]);
export type UsageServiceKind = Static<typeof UsageServiceKindSchema>;
const PresetRangeSchema = Type.Union([Type.Literal("month"), Type.Literal("7d"), Type.Literal("30d"), Type.Literal("today")]);
export const UsageRangeSchema = Type.Union([PresetRangeSchema, Type.Literal("custom")]);
export type UsageRange = Static<typeof UsageRangeSchema>;
export const UsageMetricsSchema = Type.Object({
  inputTokens: Metric, outputTokens: Metric, cacheReadTokens: Metric, cacheWriteTokens: Metric, totalTokens: Metric,
  usageStatus: Type.Union([Type.Literal("reported"), Type.Literal("partial"), Type.Literal("unknown")]),
}, { additionalProperties: false });
export type UsageMetrics = Static<typeof UsageMetricsSchema>;

const identity = {
  attemptId: Id, operationId: Id, sourceId: Type.Optional(Id), taskId: Type.Optional(Id),
  stageId: Type.Optional(Id), parentTaskId: Type.Optional(Id), serviceKind: UsageServiceKindSchema,
  profileId: Type.Optional(Id), profileName: Type.String({ minLength: 1, maxLength: 120, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  providerId: Id, modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), configRevisionId: Id, draftSessionId: Type.Optional(Id), startedAt: Utc,
};
const common = {
  ...identity, ...UsageMetricsSchema.properties, resultCount: Metric, revision: Counter,
  attemptCountStatus: Type.Union([Type.Literal("complete"), Type.Literal("incomplete")]), errorCode: SafeError,
};
export const UsageStartSchema = Type.Object({ ...common, outcome: Type.Literal("running"), finishedAt: Type.Null(), durationMs: Type.Null() }, { additionalProperties: false });
export const UsageFinishSchema = Type.Object({
  ...common, outcome: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted")]),
  finishedAt: Utc, durationMs: Metric,
}, { additionalProperties: false });
export const UsageAttemptSchema = Type.Union([UsageStartSchema, UsageFinishSchema]);
export type UsageStart = Static<typeof UsageStartSchema>;
export type UsageFinish = Static<typeof UsageFinishSchema>;
export type UsageAttempt = Static<typeof UsageAttemptSchema>;
export type UsageOutcome = UsageAttempt["outcome"];

export function normalizeUsageMetrics(input: Partial<Omit<UsageMetrics, "usageStatus">>): UsageMetrics {
  const values = {
    inputTokens: input.inputTokens ?? null, outputTokens: input.outputTokens ?? null,
    cacheReadTokens: input.cacheReadTokens ?? null, cacheWriteTokens: input.cacheWriteTokens ?? null,
    totalTokens: input.totalTokens ?? null,
  };
  for (const value of Object.values(values)) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error("invalid_usage_metric");
  }
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = values;
  if (inputTokens !== null && (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) > inputTokens) throw new Error("invalid_cache_subset");
  if (inputTokens !== null && outputTokens !== null) {
    values.totalTokens = inputTokens + outputTokens;
    if (!Number.isSafeInteger(values.totalTokens)) throw new Error("invalid_usage_total");
  }
  return { ...values, usageStatus: inputTokens !== null && outputTokens !== null ? "reported"
    : Object.values(values).some((value) => value !== null) ? "partial" : "unknown" };
}

export function parseUsageAttempt(value: unknown): UsageAttempt {
  if (!Value.Check(UsageAttemptSchema, value)) throw new Error("invalid_usage_record");
  const record = value as UsageAttempt;
  validateUtc(record.startedAt);
  if (record.finishedAt !== null) {
    validateUtc(record.finishedAt);
    if (record.finishedAt < record.startedAt) throw new Error("invalid_usage_time");
  }
  const normalized = normalizeUsageMetrics(record);
  for (const key of Object.keys(normalized) as (keyof UsageMetrics)[]) {
    if (record[key] !== normalized[key]) throw new Error("inconsistent_usage_metrics");
  }
  if (record.serviceKind === "llm" && (record.modelId === undefined || record.resultCount !== null)) throw new Error("invalid_llm_record");
  if (record.serviceKind === "search" && (record.modelId !== undefined || record.usageStatus !== "unknown")) throw new Error("invalid_search_record");
  if (record.profileId !== undefined && record.draftSessionId !== undefined) throw new Error("ambiguous_usage_profile");
  return { ...record, sourceId: record.sourceId ?? "unclassified" };
}

export function validateUtc(value: string): void {
  if (!Value.Check(Utc, value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("invalid_usage_time");
}

export const UsageModelIdentitySchema = Type.Object({ providerId: Id, modelId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
export type UsageModelIdentity = Static<typeof UsageModelIdentitySchema>;
const timeZone = Type.String({ minLength: 1, maxLength: 100 });
const localDate = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const preset = { range: PresetRangeSchema, timeZone };
const custom = { range: Type.Literal("custom"), timeZone, startDate: localDate, endDate: localDate };
const llm = { serviceKind: Type.Literal("llm"), model: Type.Optional(UsageModelIdentitySchema) };
const search = { serviceKind: Type.Literal("search") };
export const UsageDashboardQuerySchema = Type.Union([
  Type.Object({ ...llm, ...preset }, { additionalProperties: false }),
  Type.Object({ ...llm, ...custom }, { additionalProperties: false }),
  Type.Object({ ...search, ...preset }, { additionalProperties: false }),
  Type.Object({ ...search, ...custom }, { additionalProperties: false }),
]);
export type UsageDashboardQuery = Static<typeof UsageDashboardQuerySchema>;
export interface UsageQuery { serviceKind: UsageServiceKind; from: string; to: string; timeZone: string }
export interface UsageSummary {
  requests: number; running: number; succeeded: number; failed: number; cancelled: number; interrupted: number;
  inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null;
  cacheWriteTokens: number | null; totalTokens: number | null; resultCount: number | null;
  reportedUsageRequests: number; unknownUsageRequests: number; partialUsageRequests: number; incompleteAttemptCountRequests: number;
}
export type UsageCoverage = "untracked" | "partial" | "tracked";
export interface UsageDailyPoint extends UsageSummary { date: string; from: string; to: string; coverage: UsageCoverage }
export interface UsageTrendSummary extends UsageSummary {
  inputCacheHitTokens: number | null; inputCacheMissTokens: number | null; inputCacheUnknownTokens: number | null;
  cacheSplitUnknownRequests: number;
}
export interface UsageTrendPoint extends UsageTrendSummary { date: string; from: string; to: string; coverage: UsageCoverage; label: string; future: boolean }
export interface UsageTrend {
  granularity: "hour" | "day"; points: UsageTrendPoint[]; summary: UsageTrendSummary;
  models: UsageModelIdentity[]; selectedModel: UsageModelIdentity | null;
}
export interface UsageModelBreakdown extends UsageSummary { modelId: string }
export interface UsageProviderBreakdown extends UsageSummary { providerId: string; models: UsageModelBreakdown[] }
export interface UsageDeliveryHealth { pendingRecords: number; failedRecords: number; droppedRecords: number; lastErrorCode: string | null }
export interface UsageHealth extends UsageDeliveryHealth {
  collectionStartedAt: string; lastInitializedAt: string; cleanShutdown: boolean;
  previousUncleanShutdown: boolean; interruptedRequests: number; degraded: boolean;
}
export interface UsageDashboard {
  summary: UsageSummary; daily: UsageDailyPoint[]; providers: UsageProviderBreakdown[]; health: UsageHealth;
  trend: UsageTrend;
  from: string; to: string; timeZone: string;
}
export interface UsageDashboardApi { getDashboard(query: UsageDashboardQuery): Promise<UsageDashboard> }
export interface UsageRecorder { recordStart(start: UsageStart): Promise<boolean>; recordFinish(finish: UsageFinish): Promise<boolean> }
export interface UsageRepository {
  initialize(now: string): UsageHealth;
  upsert(attempt: UsageAttempt): "inserted" | "updated" | "ignored";
  readRange(query: UsageQuery): UsageAttempt[];
  getHealth(): UsageHealth;
  setDeliveryHealth(health: Partial<UsageDeliveryHealth>): void;
  markCleanShutdown(): void;
}
export interface UsageQueryService extends UsageDashboardApi {
  getSummary(query: UsageQuery): Promise<UsageSummary>;
  getDailySeries(query: UsageQuery): Promise<UsageDailyPoint[]>;
  getBreakdown(query: UsageQuery): Promise<UsageProviderBreakdown[]>;
  getHealth(): Promise<UsageHealth>;
}

// Used by the persistence adapter. Identity and configuration are frozen at first delivery.
export function assertSameUsageIdentity(previous: UsageAttempt, next: UsageAttempt): void {
  for (const field of Object.keys(identity) as (keyof typeof identity)[]) {
    if (previous[field] !== next[field]) throw new Error("usage_identity_conflict");
  }
}

export function validateDeliveryHealth(health: Partial<UsageDeliveryHealth>): void {
  const schema = Type.Partial(Type.Object({ pendingRecords: Counter, failedRecords: Counter, droppedRecords: Counter, lastErrorCode: SafeError }, { additionalProperties: false }));
  if (!Value.Check(schema, health)) throw new Error("invalid_usage_health");
}
