import { Type, type Static } from "typebox";

export const ToolIdentitySchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type ToolIdentity = Static<typeof ToolIdentitySchema>;

export const ToolCallRequestSchema = Type.Object(
  {
    executionId: Type.String(),
    traceId: Type.String(),
    tool: ToolIdentitySchema,
    input: Type.Object({}, { additionalProperties: true }),
  },
  { additionalProperties: false },
);
export type ToolCallRequest = Static<typeof ToolCallRequestSchema>;

export const ToolFailureSchema = Type.Object(
  {
    code: Type.String(),
    message: Type.String(),
    retryable: Type.Boolean(),
    attempts: Type.Integer({ minimum: 1 }),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type ToolFailure = Static<typeof ToolFailureSchema>;

const resultFields = {
  executionId: Type.String(),
  traceId: Type.String(),
  tool: ToolIdentitySchema,
  attempts: Type.Integer({ minimum: 1 }),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
};

export const ToolExecutionResultSchema = Type.Union([
  Type.Object(
    { ...resultFields, status: Type.Literal("completed"), output: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...resultFields, status: Type.Literal("failed"), failure: ToolFailureSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...resultFields, status: Type.Literal("cancelled"), failure: Type.Optional(ToolFailureSchema) },
    { additionalProperties: false },
  ),
]);
export type ToolExecutionResult = Static<typeof ToolExecutionResultSchema>;

const eventFields = {
  executionId: Type.String(),
  traceId: Type.String(),
  tool: ToolIdentitySchema,
  sequence: Type.Integer({ minimum: 0 }),
  timestamp: Type.Number(),
};

export const ToolExecutionEventSchema = Type.Union([
  Type.Object({ ...eventFields, type: Type.Literal("accepted") }, { additionalProperties: false }),
  Type.Object({ ...eventFields, type: Type.Literal("validated") }, { additionalProperties: false }),
  Type.Object(
    { ...eventFields, type: Type.Literal("policy_checked") },
    { additionalProperties: false },
  ),
  Type.Object({ ...eventFields, type: Type.Literal("started") }, { additionalProperties: false }),
  Type.Object(
    { ...eventFields, type: Type.Literal("progress"), progress: Type.Unknown() },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...eventFields, type: Type.Literal("retry_scheduled"), retryDelayMs: Type.Number({ minimum: 0 }) },
    { additionalProperties: false },
  ),
  Type.Object({ ...eventFields, type: Type.Literal("completed") }, { additionalProperties: false }),
  Type.Object(
    { ...eventFields, type: Type.Literal("failed"), failure: ToolFailureSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...eventFields, type: Type.Literal("cancelled"), failure: Type.Optional(ToolFailureSchema) },
    { additionalProperties: false },
  ),
]);
export type ToolExecutionEvent = Static<typeof ToolExecutionEventSchema>;

export const ToolManifestEntrySchema = Type.Object(
  {
    identity: ToolIdentitySchema,
    label: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    effect: Type.String({ minLength: 1 }),
    timeoutMs: Type.Integer({ minimum: 1 }),
    retry: Type.Object(
      {
        maxRetries: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2)]),
        backoffMs: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    concurrency: Type.Integer({ minimum: 1 }),
    meter: Type.Object(
      {
        category: Type.String({ minLength: 1 }),
        countsBytes: Type.Boolean(),
        countsTime: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ToolManifestEntry = Static<typeof ToolManifestEntrySchema>;
