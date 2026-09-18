import { Type } from "typebox";
import { UsageDashboardQuerySchema, UsageModelIdentitySchema } from "@deepfield/base/usage";
export const UsageDashboardArgsSchema = Type.Tuple([UsageDashboardQuerySchema]);
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableCount = Type.Union([count, Type.Null()]);
const summary = { requests: count, running: count, succeeded: count, failed: count, cancelled: count, interrupted: count,
  inputTokens: nullableCount, outputTokens: nullableCount, cacheReadTokens: nullableCount, cacheWriteTokens: nullableCount, totalTokens: nullableCount, resultCount: nullableCount,
  reportedUsageRequests: count, unknownUsageRequests: count, partialUsageRequests: count, incompleteAttemptCountRequests: count };
const trendSummary = { ...summary, inputCacheHitTokens: nullableCount, inputCacheMissTokens: nullableCount, inputCacheUnknownTokens: nullableCount, cacheSplitUnknownRequests: count };
const point = { date: Type.String(), from: Type.String(), to: Type.String(), coverage: Type.Union([Type.Literal("untracked"), Type.Literal("partial"), Type.Literal("tracked")]) };
export const UsageDeliveryHealthSchema = Type.Object({ pendingRecords: count, failedRecords: count, droppedRecords: count, lastErrorCode: Type.Union([Type.String({ maxLength: 80, pattern: "^[a-zA-Z0-9_.-]+$" }), Type.Null()]) }, { additionalProperties: false });
export const UsageHealthEnvelopeSchema = Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9-]+$" }), health: UsageDeliveryHealthSchema }, { additionalProperties: false });
export const UsageFlushRequestSchema = Type.Object({ kind: Type.Literal("usage.flush"), requestId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
export const UsageFlushReplySchema = Type.Object({ kind: Type.Literal("usage.flushed"), requestId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
export const UsageDashboardSchema = Type.Object({
  summary: Type.Object(summary, { additionalProperties: false }),
  daily: Type.Array(Type.Object({ ...summary, ...point }, { additionalProperties: false }), { maxItems: 366 }),
  trend: Type.Object({
    granularity: Type.Union([Type.Literal("hour"), Type.Literal("day")]),
    points: Type.Array(Type.Object({ ...trendSummary, ...point, label: Type.String({ maxLength: 100 }), future: Type.Boolean() }, { additionalProperties: false }), { maxItems: 366 }),
    summary: Type.Object(trendSummary, { additionalProperties: false }),
    models: Type.Array(UsageModelIdentitySchema),
    selectedModel: Type.Union([UsageModelIdentitySchema, Type.Null()]),
  }, { additionalProperties: false }),
  providers: Type.Array(Type.Object({ ...summary, providerId: Type.String({ maxLength: 200 }), models: Type.Array(Type.Object({ ...summary, modelId: Type.String({ maxLength: 200 }) }, { additionalProperties: false })) }, { additionalProperties: false })),
  health: Type.Object({ ...UsageDeliveryHealthSchema.properties, collectionStartedAt: Type.String(), lastInitializedAt: Type.String(), cleanShutdown: Type.Boolean(), previousUncleanShutdown: Type.Boolean(), interruptedRequests: count, degraded: Type.Boolean() }, { additionalProperties: false }),
  from: Type.String(), to: Type.String(), timeZone: Type.String({ maxLength: 100 }),
}, { additionalProperties: false });
