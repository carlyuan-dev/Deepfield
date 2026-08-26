import { Type, type Static } from "typebox";
import type { ConversationId, MessageId } from "./ids.js";

export const AgentContextMessageSchema = Type.Object(
  {
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    content: Type.String(),
    timestamp: Type.Number(),
  },
  { additionalProperties: false },
);
export type AgentContextMessage = Static<typeof AgentContextMessageSchema>;

export const AgentContextSnapshotSchema = Type.Object(
  {
    projectId: Type.String(),
    conversationId: Type.String(),
    systemPrompt: Type.String(),
    messages: Type.Array(AgentContextMessageSchema),
  },
  { additionalProperties: false },
);
export type AgentContextSnapshot = Static<typeof AgentContextSnapshotSchema>;

export const AgentWorkerRequestSchema = Type.Object(
  {
    requestId: Type.String(),
    kind: Type.Literal("chat.prompt"),
    prompt: Type.String(),
    context: AgentContextSnapshotSchema,
    apiKey: Type.String(),
    modelId: Type.Literal("deepseek-chat"),
  },
  { additionalProperties: false },
);
export type AgentWorkerRequest = Static<typeof AgentWorkerRequestSchema>;

export const AgentWorkerEventSchema = Type.Union([
  Type.Object(
    { requestId: Type.String(), type: Type.Literal("started") },
    { additionalProperties: false },
  ),
  Type.Object(
    { requestId: Type.String(), type: Type.Literal("text_delta"), delta: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { requestId: Type.String(), type: Type.Literal("completed"), text: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      requestId: Type.String(),
      type: Type.Literal("failed"),
      code: Type.String(),
      message: Type.String(),
    },
    { additionalProperties: false },
  ),
]);
export type AgentWorkerEvent = Static<typeof AgentWorkerEventSchema>;

export interface ChatMessage {
  id: MessageId;
  conversationId: ConversationId;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}
