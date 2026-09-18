import { Type, type Static, type TProperties } from "typebox";
import { UsageAttemptSchema } from "@deepfield/base/usage";
import { UsageHealthEnvelopeSchema, UsageFlushRequestSchema, UsageFlushReplySchema } from "./usage.js";
import { AgentWorkerEventSchema, AgentWorkerRequestSchema } from "./chat.js";
import { CompanyProfileWorkerRequestSchema, CompanyProfileWorkerEventSchema } from "./company-profile.js";
import {
  CompanyResearchCancelRequestSchema,
  CompanyResearchWorkerEventSchema,
  CompanyResearchRawWorkerRequestSchema,
  CompanyResearchStructureWorkerRequestSchema,
} from "./research.js";
import {
  JsonObjectSchema,
  ToolExecutionEventSchema,
  ToolIdentitySchema,
} from "./tools.js";

export const ToolActorSchema = Type.Union([
  Type.Literal("main_agent"),
  Type.Literal("capability"),
  Type.Literal("child_agent"),
  Type.Literal("direct_ui"),
  Type.Literal("developer_probe"),
]);
export type ToolActor = Static<typeof ToolActorSchema>;

/** Stable ToolFailureCode literals mirroring @deepfield/tool-platform codes. */
export const ToolFailureCodeSchema = Type.Union([
  Type.Literal("invalid_input"),
  Type.Literal("tool_not_found"),
  Type.Literal("tool_not_allowed"),
  Type.Literal("permission_denied"),
  Type.Literal("confirmation_required"),
  Type.Literal("budget_exceeded"),
  Type.Literal("timeout"),
  Type.Literal("cancelled"),
  Type.Literal("rate_limited"),
  Type.Literal("authentication_failed"),
  Type.Literal("network_unavailable"),
  Type.Literal("url_blocked"),
  Type.Literal("redirect_blocked"),
  Type.Literal("response_too_large"),
  Type.Literal("unsupported_content_type"),
  Type.Literal("parse_failed"),
  Type.Literal("invalid_output"),
  Type.Literal("executor_failed"),
  Type.Literal("audit_failed"),
]);
export type ToolFailureCodeContract = Static<typeof ToolFailureCodeSchema>;

/**
 * tool.run carries the ToolCallRequest plus the safe ToolRunContext data the
 * Utility needs (trace/actor/project). It never carries executors, ToolSet,
 * secrets, database handles or functions: permissions are chosen by the
 * trusted Utility assembly, never self-reported by Main/Renderer/Agent.
 * `requestId` is the per-call unique transport generation id; `executionId`
 * is the logical tool execution id protected by the Utility active map.
 */
export const ToolRunRequestSchema = Type.Object(
  {
    requestId: Type.String({ minLength: 1 }),
    kind: Type.Literal("tool.run"),
    executionId: Type.String({ minLength: 1 }),
    traceId: Type.String({ minLength: 1 }),
    tool: ToolIdentitySchema,
    input: JsonObjectSchema,
    actor: ToolActorSchema,
    projectId: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type ToolRunRequest = Static<typeof ToolRunRequestSchema>;

export const UtilityWorkerRequestSchema = Type.Union([
  UsageFlushRequestSchema,
  CompanyProfileWorkerRequestSchema,
  AgentWorkerRequestSchema,
  CompanyResearchRawWorkerRequestSchema,
  CompanyResearchStructureWorkerRequestSchema,
  CompanyResearchCancelRequestSchema,
  ToolRunRequestSchema,
]);
export type UtilityWorkerRequest = Static<typeof UtilityWorkerRequestSchema>;

/**
 * Strict envelope for Utility->Main tool events: the transport requestId is the
 * per-call generation, so late envelopes from an old generation can never be
 * mistaken for a newer one with the same executionId.
 */
export const ToolEventEnvelopeSchema = Type.Object(
  {
    kind: Type.Literal("tool.event"),
    requestId: Type.String({ minLength: 1 }),
    event: ToolExecutionEventSchema,
  },
  { additionalProperties: false },
);
export type ToolEventEnvelope = Static<typeof ToolEventEnvelopeSchema>;

export const HostAuditStartPayloadSchema = Type.Object(
  {
    executionId: Type.String({ minLength: 1 }),
    traceId: Type.String({ minLength: 1 }),
    projectId: Type.Optional(Type.String({ minLength: 1 })),
    actor: ToolActorSchema,
    toolName: Type.String({ minLength: 1 }),
    toolVersion: Type.Integer({ minimum: 1 }),
    agentTurnIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    batchId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export type HostAuditStartPayload = Static<typeof HostAuditStartPayloadSchema>;

function withAuditFinishConsumption<const T extends TProperties>(properties: T) {
  return Type.Union([
    Type.Object(
      { ...properties, attempts: Type.Integer({ minimum: 0 }), budgetConsumed: Type.Literal(false) },
      { additionalProperties: false },
    ),
    Type.Object(
      { ...properties, attempts: Type.Integer({ minimum: 1 }), budgetConsumed: Type.Literal(true) },
      { additionalProperties: false },
    ),
  ]);
}

/** status ↔ errorCode and attempts ↔ consumption consistency enforced at schema level. */
export const HostAuditFinishPayloadSchema = Type.Union([
  withAuditFinishConsumption(
    {
      executionId: Type.String({ minLength: 1 }),
      traceId: Type.String({ minLength: 1 }),
      status: Type.Literal("completed"),
      durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    },
  ),
  withAuditFinishConsumption(
    {
      executionId: Type.String({ minLength: 1 }),
      traceId: Type.String({ minLength: 1 }),
      status: Type.Literal("failed"),
      errorCode: ToolFailureCodeSchema,
      durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    },
  ),
  withAuditFinishConsumption(
    {
      executionId: Type.String({ minLength: 1 }),
      traceId: Type.String({ minLength: 1 }),
      status: Type.Literal("cancelled"),
      errorCode: Type.Optional(ToolFailureCodeSchema),
      durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    },
  ),
]);
export type HostAuditFinishPayload = Static<typeof HostAuditFinishPayloadSchema>;

const hostAuditSyntheticFields = {
  executionId: Type.String({ minLength: 1 }),
  traceId: Type.String({ minLength: 1 }),
  projectId: Type.Optional(Type.String({ minLength: 1 })),
  actor: ToolActorSchema,
  toolName: Type.String({ minLength: 1 }),
  toolVersion: Type.Integer({ minimum: 1 }),
  agentTurnIndex: Type.Integer({ minimum: 0 }),
  batchId: Type.String({ minLength: 1, maxLength: 64 }),
  toolCallId: Type.String({ minLength: 1, maxLength: 128 }),
  attempts: Type.Literal(0),
  budgetConsumed: Type.Literal(false),
};

export const HostAuditSyntheticPayloadSchema = Type.Union([
  Type.Object(
    {
      ...hostAuditSyntheticFields,
      status: Type.Literal("skipped"),
      errorCode: Type.Literal("budget_trimmed"),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...hostAuditSyntheticFields,
      status: Type.Literal("reused"),
      errorCode: Type.Optional(ToolFailureCodeSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...hostAuditSyntheticFields,
      status: Type.Literal("failed"),
      errorCode: Type.Literal("invalid_input"),
    },
    { additionalProperties: false },
  ),
]);
export type HostAuditSyntheticPayload = Static<typeof HostAuditSyntheticPayloadSchema>;

export const HostSecretRequestPayloadSchema = Type.Object(
  { provider: Type.Literal("deepseek") },
  { additionalProperties: false },
);
export type HostSecretRequestPayload = Static<typeof HostSecretRequestPayloadSchema>;

const HostConversationIdSchema = Type.String({ minLength: 1, maxLength: 200 });
const HostConversationTitleSchema = Type.String({ maxLength: 200 });
const HostConversationTimestampSchema = Type.String({ minLength: 1, maxLength: 64 });

export const HostConversationSummarySchema = Type.Object(
  {
    id: HostConversationIdSchema,
    title: HostConversationTitleSchema,
    updatedAt: HostConversationTimestampSchema,
  },
  { additionalProperties: false },
);
export type HostConversationSummary = Static<typeof HostConversationSummarySchema>;

export const HostConversationMessageSchema = Type.Object(
  {
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    content: Type.String({ maxLength: 4000 }),
  },
  { additionalProperties: false },
);
export type HostConversationMessage = Static<typeof HostConversationMessageSchema>;

export const HostConversationDetailSchema = Type.Object(
  {
    conversationId: HostConversationIdSchema,
    title: HostConversationTitleSchema,
    messages: Type.Array(HostConversationMessageSchema, { maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type HostConversationDetail = Static<typeof HostConversationDetailSchema>;

export const HostConversationSearchResultSchema = Type.Object(
  {
    conversationId: HostConversationIdSchema,
    title: HostConversationTitleSchema,
    snippet: Type.Optional(Type.String({ maxLength: 240 })),
    updatedAt: HostConversationTimestampSchema,
  },
  { additionalProperties: false },
);
export type HostConversationSearchResult = Static<typeof HostConversationSearchResultSchema>;

export const HostConversationListPayloadSchema = Type.Object(
  { conversations: Type.Array(HostConversationSummarySchema, { maxItems: 30 }) },
  { additionalProperties: false },
);
export const HostConversationReadPayloadSchema = Type.Object(
  { conversation: Type.Union([HostConversationDetailSchema, Type.Null()]) },
  { additionalProperties: false },
);
export const HostConversationSearchPayloadSchema = Type.Object(
  { results: Type.Array(HostConversationSearchResultSchema, { maxItems: 30 }) },
  { additionalProperties: false },
);

/** Narrow host RPC requests: explicit audit, secret and read-only conversation methods. */
export const HostRequestSchema = Type.Union([
  Type.Object({ hostRequestId: Type.String({ minLength: 1 }), kind: Type.Literal("host.request"), method: Type.Literal("usage.record"), payload: UsageAttemptSchema }, { additionalProperties: false }),
  Type.Object({ hostRequestId: Type.String({ minLength: 1 }), kind: Type.Literal("host.request"), method: Type.Literal("usage.health"), payload: UsageHealthEnvelopeSchema }, { additionalProperties: false }),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.request"),
      method: Type.Literal("audit.start"),
      payload: HostAuditStartPayloadSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.request"),
      method: Type.Literal("audit.finish"),
      payload: HostAuditFinishPayloadSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.request"),
      method: Type.Literal("audit.synthetic"),
      payload: HostAuditSyntheticPayloadSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.request"),
      method: Type.Literal("secret.getProviderKey"),
      payload: HostSecretRequestPayloadSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.request"),
      method: Type.Literal("conversation.listRecent"),
      payload: Type.Object(
        { limit: Type.Integer({ minimum: 1, maximum: 30 }) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.request"),
      method: Type.Literal("conversation.read"),
      payload: Type.Object(
        {
          conversationId: HostConversationIdSchema,
          limit: Type.Integer({ minimum: 1, maximum: 100 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.request"),
      method: Type.Literal("conversation.search"),
      payload: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 200 }),
          maxResults: Type.Integer({ minimum: 1, maximum: 30 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type HostRequest = Static<typeof HostRequestSchema>;

export const HostRpcMethodSchema = Type.Union([
  Type.Literal("usage.record"),
  Type.Literal("usage.health"),
  Type.Literal("audit.start"),
  Type.Literal("audit.finish"),
  Type.Literal("audit.synthetic"),
  Type.Literal("secret.getProviderKey"),
  Type.Literal("conversation.listRecent"),
  Type.Literal("conversation.read"),
  Type.Literal("conversation.search"),
]);
export type HostRpcMethod = Static<typeof HostRpcMethodSchema>;

/** Fixed host error codes: never arbitrary strings that could carry secrets. */
export const HostErrorCodeSchema = Type.Union([
  Type.Literal("usage_failed"),
  Type.Literal("audit_failed"),
  Type.Literal("secret_unavailable"),
  Type.Literal("conversation_unavailable"),
  Type.Literal("invalid_request"),
  Type.Literal("host_disposed"),
  Type.Literal("host_protocol_error"),
]);

/**
 * Method-discriminated replies: every success payload is fixed to its method;
 * cross-method data and generic database responses are rejected.
 */
export const HostReplySchema = Type.Union([
  Type.Object({ hostRequestId: Type.String({ minLength: 1 }), kind: Type.Literal("host.reply"), method: Type.Literal("usage.record"), ok: Type.Literal(true), payload: Type.Object({ acknowledged: Type.Literal(true) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ hostRequestId: Type.String({ minLength: 1 }), kind: Type.Literal("host.reply"), method: Type.Literal("usage.health"), ok: Type.Literal(true), payload: Type.Object({ acknowledged: Type.Literal(true) }, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      method: Type.Literal("audit.start"),
      ok: Type.Literal(true),
      payload: Type.Object({ acknowledged: Type.Literal(true) }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      method: Type.Literal("audit.synthetic"),
      ok: Type.Literal(true),
      payload: Type.Object({ acknowledged: Type.Literal(true) }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      method: Type.Literal("audit.finish"),
      ok: Type.Literal(true),
      payload: Type.Object({ acknowledged: Type.Literal(true) }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      method: Type.Literal("secret.getProviderKey"),
      ok: Type.Literal(true),
      payload: Type.Object(
        { apiKey: Type.Union([Type.String(), Type.Null()]) },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      method: Type.Literal("conversation.listRecent"),
      ok: Type.Literal(true),
      payload: HostConversationListPayloadSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      method: Type.Literal("conversation.read"),
      ok: Type.Literal(true),
      payload: HostConversationReadPayloadSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      method: Type.Literal("conversation.search"),
      ok: Type.Literal(true),
      payload: HostConversationSearchPayloadSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      method: HostRpcMethodSchema,
      ok: Type.Literal(false),
      code: HostErrorCodeSchema,
    },
    { additionalProperties: false },
  ),
  // Schema-valid protocol failure variant for malformed/unknown-method or
  // host-disposed cases where no business method can be echoed back.
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      method: Type.Literal("host.protocol"),
      ok: Type.Literal(false),
      code: Type.Union([
        Type.Literal("host_disposed"),
        Type.Literal("invalid_request"),
        Type.Literal("host_protocol_error"),
      ]),
    },
    { additionalProperties: false },
  ),
]);
export type HostReply = Static<typeof HostReplySchema>;

export const UtilityWorkerEventSchema = Type.Union([
  UsageFlushReplySchema,
  ...CompanyProfileWorkerEventSchema.anyOf,
  ...AgentWorkerEventSchema.anyOf,
  ...CompanyResearchWorkerEventSchema.anyOf,
  ToolEventEnvelopeSchema,
  HostReplySchema,
]);
export type UtilityWorkerEvent = Static<typeof UtilityWorkerEventSchema>;
