import { Type, type Static } from "typebox";
import { OperationPresentationSchema } from "@deepfield/capability-sdk";

const id = Type.String({ minLength: 1 });
export const ChatCapabilityTaskCardSchema = Type.Object({
  interactionId: Type.Optional(id),
  conversationId: id, sourceRequestId: id, analyzeAfter: Type.Boolean(),
  analysisState: Type.Union([Type.Literal("none"), Type.Literal("pending"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("interrupted")]),
  consumedEventId: Type.Optional(id),
  snapshot: Type.Object({ taskRef: Type.Object({ capabilityId: id, taskId: id }, { additionalProperties: false }),
    status: Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("paused"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted")]),
    message: Type.Optional(id), phase: Type.Optional(id), progress: Type.Optional(Type.Number()),
    cancellable: Type.Optional(Type.Boolean()), artifactRefs: Type.Optional(Type.Array(Type.Object({ capabilityId: id, artifactId: id, revision: id }, { additionalProperties: false }))),
    viewRefs: Type.Optional(Type.Array(Type.Object({ capabilityId: id, viewId: id, input: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }))),
    createdAt: Type.Optional(id), updatedAt: Type.Optional(id), finishedAt: Type.Optional(id), warnings: Type.Optional(Type.Array(id)),
    error: Type.Optional(Type.Object({ code: id, message: id, retryable: Type.Boolean(), recovery: Type.Optional(id) }, { additionalProperties: false })),
    presentation: Type.Optional(OperationPresentationSchema),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type ChatCapabilityTaskCard = Static<typeof ChatCapabilityTaskCardSchema>;
export const ChatCapabilityConfirmationSchema = Type.Object({ confirmationRef: id, capabilityId: id, actionId: id,
  sourceRequestId: id, invocationId: id, inputSummary: Type.Unknown(), analyzeAfter: Type.Boolean(), presentation: Type.Optional(OperationPresentationSchema) }, { additionalProperties: false });
export type ChatCapabilityConfirmation = Static<typeof ChatCapabilityConfirmationSchema>;
export const ChatCapabilityOperationCardSchema = Type.Object({ conversationId: id, sourceRequestId: id, invocationId: id,
  interactionId: Type.Optional(id),
  status: Type.Union([Type.Literal("awaiting_confirmation"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("interrupted"), Type.Literal("uncertain")]),
  title: Type.String(), presentation: Type.Optional(OperationPresentationSchema) }, { additionalProperties: false });
export type ChatCapabilityOperationCard = Static<typeof ChatCapabilityOperationCardSchema>;
export const ChatCapabilityViewSchema = Type.Object({ conversationId: id, sourceRequestId: id,
  target: Type.Union([
    Type.Object({ capabilityId: id, viewId: id, input: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }),
    Type.Object({ capabilityId: id, draftId: id, revision: id }, { additionalProperties: false }),
  ]) }, { additionalProperties: false });
export type ChatCapabilityView = Static<typeof ChatCapabilityViewSchema>;
