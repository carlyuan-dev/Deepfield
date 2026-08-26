import { Type, type Static } from "typebox";
import type { ConversationId, MessageId } from "./ids.js";

export const AgentWorkerEventSchema = Type.Union([
  Type.Object({ requestId: Type.String(), type: Type.Literal("started") }),
  Type.Object({ requestId: Type.String(), type: Type.Literal("text_delta"), delta: Type.String() }),
  Type.Object({ requestId: Type.String(), type: Type.Literal("completed"), text: Type.String() }),
  Type.Object({ requestId: Type.String(), type: Type.Literal("failed"), code: Type.String(), message: Type.String() }),
]);
export type AgentWorkerEvent = Static<typeof AgentWorkerEventSchema>;

export interface ChatMessage {
  id: MessageId;
  conversationId: ConversationId;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentContextSnapshot {
  projectId: string;
  conversationId: string;
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp: number }>;
}

export interface AgentWorkerRequest {
  requestId: string;
  kind: "chat.prompt";
  prompt: string;
  context: AgentContextSnapshot;
  apiKey: string;
  modelId: "deepseek-chat";
}
