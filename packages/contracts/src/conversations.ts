import type { ConversationId } from "./ids.js";

export interface Conversation {
  id: ConversationId;
  title: string;
  hasUserMessage: boolean;
  createdAt: string;
  updatedAt: string;
}
