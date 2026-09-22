import { Type } from "typebox";
import { UsageDashboardQuerySchema, UsageModelIdentitySchema } from "@deepfield/base/usage";
export const UsageDashboardArgsSchema = Type.Tuple([UsageDashboardQuerySchema]);
const usageDeletionRef = Type.Object({ attemptId: Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:/@+~-]*$" }), revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false });
export const UsageDeleteUnknownFailuresArgsSchema = Type.Tuple([Type.Array(usageDeletionRef, { maxItems: 1000 })]);
export const UsageRepairArgsSchema = Type.Tuple([]);
export const UsageRepairResultSchema = Type.Object({ repaired: Type.Boolean(), recoveredRecords: Type.Integer({ minimum: 0, maximum: 512 }), errorCode: Type.Union([Type.String({ maxLength: 80 }), Type.Null()]) }, { additionalProperties: false });
export const UsageAcknowledgeUnknownArgsSchema = Type.Tuple([Type.Array(Type.String({ minLength: 1, maxLength: 300, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:/@+~-]*$" }), { maxItems: 1000 })]);
export const UsageAcknowledgeHistoryArgsSchema = Type.Tuple([Type.String({ minLength: 3, maxLength: 100, pattern: "^[0-9]+:[0-9]+$" })]);
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableCount = Type.Union([count, Type.Null()]);
const summary = { requests: count, running: count, succeeded: count, failed: count, cancelled: count, interrupted: count,
  inputTokens: nullableCount, outputTokens: nullableCount, cacheReadTokens: nullableCount, cacheWriteTokens: nullableCount, totalTokens: nullableCount, resultCount: nullableCount,
  reportedUsageRequests: count, unknownUsageRequests: count, partialUsageRequests: count, incompleteAttemptCountRequests: count };
const trendSummary = { ...summary, inputCacheHitTokens: nullableCount, inputCacheMissTokens: nullableCount, inputCacheUnknownTokens: nullableCount, cacheSplitUnknownRequests: count };
const point = { date: Type.String(), from: Type.String(), to: Type.String(), coverage: Type.Union([Type.Literal("untracked"), Type.Literal("partial"), Type.Literal("tracked")]) };
export const UsageDeliveryHealthSchema = Type.Object({ pendingRecords: count, recoverableRecords: count, failedRecords: count, droppedRecords: count, currentFailure: Type.Boolean(), lastErrorCode: Type.Union([Type.String({ maxLength: 80, pattern: "^[a-zA-Z0-9_.-]+$" }), Type.Null()]) }, { additionalProperties: false });
export const UsageHealthEnvelopeSchema = Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9-]+$" }), health: UsageDeliveryHealthSchema }, { additionalProperties: false });
export const UsageFlushRequestSchema = Type.Object({ kind: Type.Literal("usage.flush"), requestId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
export const UsageFlushReplySchema = Type.Object({ kind: Type.Literal("usage.flushed"), requestId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
export const UsageRepairRequestSchema = Type.Object({ kind: Type.Literal("usage.repair"), requestId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
export const UsageRepairReplySchema = Type.Object({ kind: Type.Literal("usage.repaired"), requestId: Type.String({ minLength: 1, maxLength: 200 }), repaired: Type.Boolean() }, { additionalProperties: false });
export const UsageDashboardSchema = Type.Object({
  inFlightRequests: count,
  historicalNotice: Type.Object({ droppedRecords: count, interruptedRequests: count, fingerprint: Type.Union([Type.String({ maxLength: 100 }), Type.Null()]) }, { additionalProperties: false }),
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
  unknownUsage: Type.Object({ dismissibleCount: count, networkFailureCount: count, otherFailureCount: count, nonDismissibleCount: count, partialCount: count, incompleteAttemptCount: count, snapshot: Type.Array(usageDeletionRef, { maxItems: 1000 }), acknowledgeSnapshot: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 1000 }) }, { additionalProperties: false }),
  from: Type.String(), to: Type.String(), timeZone: Type.String({ maxLength: 100 }),
}, { additionalProperties: false });
