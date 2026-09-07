import type {
  ChatMessage,
  Conversation,
  ConversationId,
  MessageId,
  Project,
  ProjectId,
  ProjectScope,
} from "@deepfield/contracts";
import type {
  ActivityRow,
  ConversationRow,
  MessageRow,
  ProjectActivityEvent,
  ProjectRow,
} from "./types.js";

export function parseScope(scopeJson: string): ProjectScope {
  return JSON.parse(scopeJson) as ProjectScope;
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id as ProjectId,
    industry: row.industry,
    scope: parseScope(row.scope_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id as ConversationId,
    title: row.title,
    hasUserMessage: row.has_user_message === 1,
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
  };
}

export function toActivity(row: ActivityRow): ProjectActivityEvent {
  const base = {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    source: row.source,
    importance: row.importance,
    summary: row.summary,
    createdAt: row.created_at,
  };
  if (row.payload_json === null) {
    return base;
  }
  return { ...base, payload: JSON.parse(row.payload_json) };
}
