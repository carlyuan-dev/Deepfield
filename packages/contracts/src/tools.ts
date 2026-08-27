import { Type, type Static } from "typebox";
import { Format } from "typebox/format";

// Registered once per process. TypeBox's plain Number schema cannot reject
// NaN/Infinity, so the JSON-safe contracts pair Number with this finite check.
Format.Set(
  "json-finite-number",
  (value: unknown) => typeof value === "number" && Number.isFinite(value),
);

export const ToolIdentitySchema = Type.Object(
  {
    name: Type.String({ minLength: 1, pattern: "\\S" }),
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type ToolIdentity = Static<typeof ToolIdentitySchema>;

/** Recursive JSON value: null | boolean | finite number | string | array | object. */
export const JsonValueSchema = Type.Cyclic(
  {
    JsonValue: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number({ format: "json-finite-number" }),
      Type.String(),
      Type.Array(Type.Ref("JsonValue")),
      Type.Record(Type.String(), Type.Ref("JsonValue")),
    ]),
  },
  "JsonValue",
);
export type JsonValue = Static<typeof JsonValueSchema>;

/** JSON object: an object whose own values are JSON values. */
export const JsonObjectSchema = Type.Object({}, { additionalProperties: JsonValueSchema });
export type JsonObject = Static<typeof JsonObjectSchema>;

export const ToolCallRequestSchema = Type.Object(
  {
    executionId: Type.String({ minLength: 1 }),
    traceId: Type.String({ minLength: 1 }),
    tool: ToolIdentitySchema,
    input: JsonObjectSchema,
  },
  { additionalProperties: false },
);
export type ToolCallRequest = Static<typeof ToolCallRequestSchema>;

export const ToolFailureSchema = Type.Object(
  {
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
    attempts: Type.Integer({ minimum: 1 }),
    metadata: Type.Optional(JsonObjectSchema),
  },
  { additionalProperties: false },
);
export type ToolFailure = Static<typeof ToolFailureSchema>;

const resultFields = {
  executionId: Type.String({ minLength: 1 }),
  traceId: Type.String({ minLength: 1 }),
  tool: ToolIdentitySchema,
  attempts: Type.Integer({ minimum: 1 }),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
};

export const ToolExecutionResultSchema = Type.Union([
  Type.Object(
    { ...resultFields, status: Type.Literal("completed"), output: JsonValueSchema },
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
  executionId: Type.String({ minLength: 1 }),
  traceId: Type.String({ minLength: 1 }),
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
    { ...eventFields, type: Type.Literal("progress"), progress: JsonValueSchema },
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
