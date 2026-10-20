import type { ChatMessage, Conversation, ConversationId, MessageId } from "@deepfield/contracts";
import type { ConversationRow, MessageRow } from "./types.js";
export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id as ConversationId,
    title: row.title,
    hasUserMessage: row.has_user_message === 1,
    webSearchEnabled: row.web_search_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id as MessageId,
    conversationId: row.conversation_id as ConversationId,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    ...(row.request_id !== null ? { requestId: row.request_id } : {}),
  };
}
