import { MemoryReferenceSchema } from "./memory.js";
import { Type, type Static } from "typebox";

const id = Type.String({ minLength: 1, maxLength: 200 });
export const ChatAgentTaskSchema = Type.Object({
  taskId: id, runId: id, title: Type.String({ minLength: 1, maxLength: 160 }),
  instruction: Type.String({ maxLength: 16000 }),
  status: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("cancelling"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("timed_out"), Type.Literal("interrupted")]),
  sequence: Type.Integer({ minimum: 1, maximum: 100 }),
  summary: Type.Optional(Type.String({ maxLength: 2000 })),
  result: Type.Optional(Type.String({ maxLength: 20000 })),
  progress: Type.Optional(Type.String({ maxLength: 500 })),
  activities: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 12 })),
  errorCode: Type.Optional(Type.String({ maxLength: 100 })),
}, { additionalProperties: false });
export type ChatAgentTask = Static<typeof ChatAgentTaskSchema>;

/** Host-owned durable envelope. Only task projections are sent to the renderer. */
export const ChatCollaborationStateSchema = Type.Object({
  version: Type.Literal(1), scopeId: id, rootRequestId: id,
  revision: Type.Integer({ minimum: 0 }),
  status: Type.Union([Type.Literal("running"), Type.Literal("waiting_user"), Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("interrupted")]),
  snapshot: Type.String({ maxLength: 4_000_000 }),
  modelCalls: Type.Integer({ minimum: 0, maximum: 32 }),
  remainingMs: Type.Number({ minimum: 0, maximum: 600_000 }),
  searchConsumed: Type.Integer({ minimum: 0 }), fetchConsumed: Type.Integer({ minimum: 0 }),
  resultCursor: Type.Integer({ minimum: 0 }),
  deliveredRunIds: Type.Optional(Type.Array(id, { maxItems: 24 })),
  memoryDependencies: Type.Optional(Type.Record(id, Type.Array(MemoryReferenceSchema, { maxItems: 100 }))),
  tasks: Type.Array(ChatAgentTaskSchema, { maxItems: 8 }),
}, { additionalProperties: false });
export type ChatCollaborationState = Static<typeof ChatCollaborationStateSchema>;

export const ChatCollaborationEventSchema = Type.Object({
  type: Type.Literal("agent_tasks"), requestId: id, scopeId: id,
  revision: Type.Integer({ minimum: 0 }), tasks: Type.Array(ChatAgentTaskSchema, { maxItems: 8 }),
}, { additionalProperties: false });

export const ChatAgentCancelSchema = Type.Object({
  kind: Type.Literal("chat.cancel"), requestId: id, taskId: Type.Optional(id),
}, { additionalProperties: false });
