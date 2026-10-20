import { Type, type Static } from "typebox";
export {
  ToolIdentitySchema, JsonValueSchema, JsonObjectSchema, ToolExecutionBatchScopeSchema,
  SyntheticToolExecutionStatusSchema, ToolCallRequestSchema, ToolFailureSchema,
  ToolExecutionResultSchema, ToolExecutionEventSchema, ToolManifestEntrySchema,
  type ToolIdentity, type JsonValue, type JsonObject, type ToolExecutionBatchScope,
  type SyntheticToolExecutionStatus, type ToolSyntheticAuditRecord, type ToolCallRequest,
  type ToolFailure, type ToolExecutionResult, type ToolExecutionEvent, type ToolManifestEntry,
} from "@deepfield/base/tools";

export const ToolAccessPolicySchema = Type.Object(
  {
    network: Type.Union([Type.Literal("disabled"), Type.Literal("enabled")]),
    maxAgentTurns: Type.Integer({ minimum: 1, maximum: 100 }),
    maxSearchCalls: Type.Integer({ minimum: 0, maximum: 100 }),
    maxFetchCalls: Type.Integer({ minimum: 0, maximum: 100 }),
  },
  { additionalProperties: false },
);
export type ToolAccessPolicy = Static<typeof ToolAccessPolicySchema>;
