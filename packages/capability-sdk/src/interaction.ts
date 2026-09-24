import { Type, type Static, type TSchema } from "typebox";

const nonEmptyText = Type.String({ minLength: 1 });

export const TaskRefSchema = Type.Object({
  capabilityId: nonEmptyText,
  taskId: nonEmptyText,
}, { additionalProperties: false });
export type TaskRef = Static<typeof TaskRefSchema>;

export const ArtifactRefSchema = Type.Object({
  capabilityId: nonEmptyText,
  artifactId: nonEmptyText,
  revision: nonEmptyText,
}, { additionalProperties: false });
export type ArtifactRef = Static<typeof ArtifactRefSchema>;

export const DraftRefSchema = Type.Object({
  capabilityId: nonEmptyText,
  draftId: nonEmptyText,
  revision: nonEmptyText,
}, { additionalProperties: false });
export type DraftRef = Static<typeof DraftRefSchema>;

export const ViewRefSchema = Type.Object({
  capabilityId: nonEmptyText,
  viewId: nonEmptyText,
  input: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
export type ViewRef = Static<typeof ViewRefSchema>;

/** Optional package-owned user copy and a single safe view target. */
export const OperationPresentationSchema = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 1000, pattern: "\\S" }),
  linkLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: "\\S" })),
  target: Type.Optional(Type.Union([ViewRefSchema, DraftRefSchema])),
  autoOpen: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type OperationPresentation = Static<typeof OperationPresentationSchema>;

export const TaskStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);
export type TaskStatus = Static<typeof TaskStatusSchema>;

export const ReadSliceSchema = Type.Object({
  format: nonEmptyText,
  data: Type.Unknown(),
  revision: nonEmptyText,
  truncated: Type.Boolean(),
  nextCursor: Type.Optional(nonEmptyText),
}, { additionalProperties: false });
export type ReadSlice = Static<typeof ReadSliceSchema>;

export const TaskSnapshotSchema = Type.Object({
  taskRef: TaskRefSchema,
  status: TaskStatusSchema,
  message: Type.Optional(nonEmptyText),
  phase: Type.Optional(nonEmptyText),
  progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  cancellable: Type.Optional(Type.Boolean()),
  artifactRefs: Type.Optional(Type.Array(ArtifactRefSchema)),
  viewRefs: Type.Optional(Type.Array(ViewRefSchema)),
  createdAt: Type.Optional(nonEmptyText),
  updatedAt: Type.Optional(nonEmptyText),
  finishedAt: Type.Optional(nonEmptyText),
  warnings: Type.Optional(Type.Array(nonEmptyText)),
  presentation: Type.Optional(OperationPresentationSchema),
  error: Type.Optional(Type.Object({ code: nonEmptyText, message: nonEmptyText, retryable: Type.Boolean(), recovery: Type.Optional(nonEmptyText) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type TaskSnapshot = Static<typeof TaskSnapshotSchema>;

export const ViewOpenResultSchema = Type.Object({
  status: Type.Union([
    Type.Literal("opened"),
    Type.Literal("blocked"),
    Type.Literal("unsupported"),
    Type.Literal("not_found"),
  ]),
  message: Type.Optional(nonEmptyText),
}, { additionalProperties: false });
export type ViewOpenResult = Static<typeof ViewOpenResultSchema>;

const ActionErrorSchema = Type.Object({
  code: nonEmptyText,
  message: nonEmptyText,
  retryable: Type.Boolean(),
  fieldErrors: Type.Optional(Type.Array(Type.Object({
    path: nonEmptyText,
    message: nonEmptyText,
  }, { additionalProperties: false }))),
  recovery: Type.Optional(nonEmptyText),
}, { additionalProperties: false });

const actionResultMetadataFields = {
  capabilityId: nonEmptyText,
  actionId: nonEmptyText,
  packageVersion: nonEmptyText,
  contractDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  invocationId: nonEmptyText,
};

export const ActionResultMetadataSchema = Type.Object(actionResultMetadataFields, { additionalProperties: false });
export type ActionResultMetadata = Static<typeof ActionResultMetadataSchema>;

function actionBranches<T extends TSchema, M extends Record<string, TSchema>>(dataSchema: T, metadata: M) {
  return [
    Type.Object({
      ...metadata,
      status: Type.Literal("completed"),
      data: dataSchema,
      artifactRefs: Type.Optional(Type.Array(ArtifactRefSchema)),
      viewRefs: Type.Optional(Type.Array(ViewRefSchema)),
      presentation: Type.Optional(OperationPresentationSchema),
    }, { additionalProperties: false }),
    Type.Object({
      ...metadata,
      status: Type.Literal("accepted"),
      taskRef: TaskRefSchema,
      taskStatus: TaskStatusSchema,
      message: Type.Optional(nonEmptyText),
      presentation: Type.Optional(OperationPresentationSchema),
    }, { additionalProperties: false }),
    Type.Object({
      ...metadata,
      status: Type.Literal("requires_confirmation"),
      confirmationRef: nonEmptyText,
      inputSummary: Type.Unknown(),
      presentation: Type.Optional(OperationPresentationSchema),
    }, { additionalProperties: false }),
    Type.Object({
      ...metadata,
      status: Type.Literal("error"),
      error: ActionErrorSchema,
      taskRef: Type.Optional(TaskRefSchema),
      presentation: Type.Optional(OperationPresentationSchema),
    }, { additionalProperties: false }),
  ] as const;
}

export function ActionOutcomeSchema<T extends TSchema>(dataSchema: T) {
  return Type.Union([...actionBranches(dataSchema, {})]);
}

export function ActionResultSchema<T extends TSchema>(dataSchema: T) {
  return Type.Union([...actionBranches(dataSchema, actionResultMetadataFields)]);
}

export type ActionOutcome<T extends TSchema> = Static<ReturnType<typeof ActionOutcomeSchema<T>>>;
export type ActionResult<T extends TSchema> = Static<ReturnType<typeof ActionResultSchema<T>>>;

export interface TaskProvider {
  permissions: { read: readonly string[]; cancel: readonly string[] };
  get(ref: TaskRef): Promise<TaskSnapshot>;
  cancel(ref: TaskRef): Promise<TaskSnapshot>;
  /** Query a committed package receipt. Must never start or replay work. */
  findByInvocation?(invocationId: string): Promise<TaskSnapshot | undefined>;
  /** Optional push feed of package-owned receipt updates; no polling contract. */
  subscribe?(listener: (snapshot: TaskSnapshot) => void): () => void;
}

export interface ArtifactReadRequest {
  cursor?: string;
  section?: string;
}

export interface ArtifactProvider {
  permissions: { read: readonly string[] };
  read(ref: ArtifactRef, request: ArtifactReadRequest): Promise<ReadSlice>;
}

export interface ViewProvider {
  /** Resolve and validate only; this must never change renderer state. */
  resolve(target: ViewRef | DraftRef): Promise<ViewResolution>;
}

export type ViewResolution = { status: "resolved"; view: ViewRef } | { status: "blocked" | "unsupported" | "not_found"; message?: string };
