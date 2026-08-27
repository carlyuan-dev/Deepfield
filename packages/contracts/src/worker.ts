import { Type, type Static } from "typebox";
import { AgentWorkerEventSchema, AgentWorkerRequestSchema } from "./chat.js";
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

/**
 * tool.run carries the ToolCallRequest plus the safe ToolRunContext data the
 * Utility needs (trace/actor/project). It never carries executors, ToolSet,
 * secrets, database handles or functions: permissions are chosen by the
 * trusted Utility assembly, never self-reported by Main/Renderer/Agent.
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
  AgentWorkerRequestSchema,
  ToolRunRequestSchema,
]);
export type UtilityWorkerRequest = Static<typeof UtilityWorkerRequestSchema>;

export const HostAuditStartPayloadSchema = Type.Object(
  {
    executionId: Type.String({ minLength: 1 }),
    traceId: Type.String({ minLength: 1 }),
    projectId: Type.Optional(Type.String({ minLength: 1 })),
    actor: ToolActorSchema,
    toolName: Type.String({ minLength: 1 }),
    toolVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type HostAuditStartPayload = Static<typeof HostAuditStartPayloadSchema>;

export const HostAuditFinishPayloadSchema = Type.Object(
  {
    executionId: Type.String({ minLength: 1 }),
    traceId: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
    attempts: Type.Integer({ minimum: 0 }),
    errorCode: Type.Optional(Type.String({ minLength: 1 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type HostAuditFinishPayload = Static<typeof HostAuditFinishPayloadSchema>;

export const HostSecretRequestPayloadSchema = Type.Object(
  { provider: Type.Literal("deepseek") },
  { additionalProperties: false },
);
export type HostSecretRequestPayload = Static<typeof HostSecretRequestPayloadSchema>;

/** Narrow host RPC requests: exactly three compile-time kinds, no generic secrets. */
export const HostRequestSchema = Type.Union([
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
      method: Type.Literal("secret.getProviderKey"),
      payload: HostSecretRequestPayloadSchema,
    },
    { additionalProperties: false },
  ),
]);
export type HostRequest = Static<typeof HostRequestSchema>;

export const HostReplySchema = Type.Union([
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      ok: Type.Literal(true),
      payload: Type.Union([
        Type.Object({ acknowledged: Type.Literal(true) }, { additionalProperties: false }),
        Type.Object(
          { apiKey: Type.Union([Type.String(), Type.Null()]) },
          { additionalProperties: false },
        ),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      hostRequestId: Type.String({ minLength: 1 }),
      kind: Type.Literal("host.reply"),
      ok: Type.Literal(false),
      code: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);
export type HostReply = Static<typeof HostReplySchema>;

export const UtilityWorkerEventSchema = Type.Union([
  ...AgentWorkerEventSchema.anyOf,
  ...ToolExecutionEventSchema.anyOf,
  HostReplySchema,
]);
export type UtilityWorkerEvent = Static<typeof UtilityWorkerEventSchema>;
