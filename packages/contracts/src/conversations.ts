import type { ConversationId } from "./ids.js";

export interface Conversation {
  id: ConversationId;
  title: string;
  hasUserMessage: boolean;
  webSearchEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}
