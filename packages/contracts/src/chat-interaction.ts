import { Type } from "typebox";
export const CHAT_INTERACTION_CHANNELS = {
  list: "chat:interactions:list", respond: "chat:interactions:respond", editorRead: "chat:interactions:editor-read",
  editorBegin: "chat:interactions:editor-begin", editorUpdate: "chat:interactions:editor-update", editorTransition: "chat:interactions:editor-transition",
  editorRespond: "chat:interactions:editor-respond", subscribe: "chat:interactions:subscribe", unsubscribe: "chat:interactions:unsubscribe", events: "chat:interactions:events",
  editorAutoOpen: "chat:interactions:editor-auto-open",
  editorOpen: "chat:interactions:editor-open",
} as const;
/** Chat owns the interaction; the operation provider owns the editable content. */
export interface InteractionOwner {
  conversationId: string;
  requestId: string;
  toolCallId: string;
}

export interface OperationRef {
  provider: string;
  operationId: string;
  contractVersion: string;
  draftRef?: string;
}

export type InteractionPayload =
  | { kind: "question"; question: string; options?: { id: string; label: string }[]; allowFreeText?: boolean }
  | { kind: "approval"; summary: string; operation: OperationRef };

export type InteractionStatus = "waiting" | "editing" | "executing" | "answered" |
  "cancelled" | "invalidated" | "submitted" | "succeeded" | "failed" | "uncertain";

export type InteractionResponse =
  | { kind: "answer"; text: string }
  | { kind: "decision"; decision: "approve" | "cancel" };

export interface RespondCommand {
  interactionId: string;
  expectedRevision: number;
  response: InteractionResponse;
}

export interface InteractionRecord extends InteractionOwner {
  id: string;
  revision: number;
  status: InteractionStatus;
  createdAt: string;
  updatedAt: string;
  /** Opaque provider version. Never compare it numerically with revision. */
  contentVersion?: string;
  receiptId?: string;
  answer?: string;
  resultSummary?: string;
  taskId?: string;
  failureReason?: string;
  payload: InteractionPayload;
}

export interface InteractionResumeEvent {
  id: string;
  interactionId: string;
  conversationId: string;
  sourceRequestId: string;
  kind: "answer" | "cancelled" | "operation_result";
  detail: string;
  state: "pending" | "claimed" | "consumed";
}

export interface OperationSnapshot { version: string; summary: string }
export type OperationResult =
  | { status: "succeeded"; summary: string }
  | { status: "submitted"; summary: string; taskId: string }
  | { status: "failed"; summary: string };
export type InteractionResponseSource = "chat_button" | "form_button" | "user_message";

export const RespondCommandSchema = Type.Object({ interactionId: Type.String({ minLength: 1 }), expectedRevision: Type.Integer({ minimum: 1 }),
  response: Type.Union([
    Type.Object({ kind: Type.Literal("answer"), text: Type.String({ minLength: 1, maxLength: 20000 }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("decision"), decision: Type.Union([Type.Literal("approve"), Type.Literal("cancel")]) }, { additionalProperties: false }),
  ]) }, { additionalProperties: false });
export interface InteractionEditorState {
  interaction: InteractionRecord;
  formId: string;
  actionId: string;
  form: {
    draft: { capabilityId: string; draftId: string; revision: string };
    view: { capabilityId: string; viewId: string; input: Record<string, unknown> };
    values: unknown; inputSchema: unknown; step?: string;
    transitions: readonly { id: string; label: string }[];
    readyToSubmit: boolean;
  };
}

const interactionId = Type.String({ minLength: 1 });
export const InteractionRecordSchema = Type.Object({
  id: interactionId, conversationId: interactionId, requestId: interactionId, toolCallId: interactionId,
  revision: Type.Integer({ minimum: 1 }), status: Type.Union(["waiting", "editing", "executing", "answered", "cancelled", "invalidated", "submitted", "succeeded", "failed", "uncertain"].map(value => Type.Literal(value))),
  createdAt: Type.String(), updatedAt: Type.String(), contentVersion: Type.Optional(Type.String()), receiptId: Type.Optional(Type.String()),
  answer: Type.Optional(Type.String()), resultSummary: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()), failureReason: Type.Optional(Type.String()),
  payload: Type.Union([
    Type.Object({ kind: Type.Literal("question"), question: Type.String(), options: Type.Optional(Type.Array(Type.Object({ id: Type.String(), label: Type.String() }))), allowFreeText: Type.Optional(Type.Boolean()) }),
    Type.Object({ kind: Type.Literal("approval"), summary: Type.String(), operation: Type.Object({ provider: interactionId, operationId: interactionId, contractVersion: interactionId, draftRef: Type.Optional(Type.String()) }) }),
  ]),
});
export const InteractionEditorStateSchema = Type.Object({ interaction: InteractionRecordSchema, formId: interactionId, actionId: interactionId,
  form: Type.Object({ draft: Type.Object({ capabilityId: interactionId, draftId: interactionId, revision: interactionId }),
    view: Type.Object({ capabilityId: interactionId, viewId: interactionId, input: Type.Record(Type.String(), Type.Unknown()) }),
    values: Type.Unknown(), inputSchema: Type.Unknown(), step: Type.Optional(Type.String()),
    transitions: Type.Array(Type.Object({ id: Type.String(), label: Type.String() })), readyToSubmit: Type.Boolean(),
  }),
});
