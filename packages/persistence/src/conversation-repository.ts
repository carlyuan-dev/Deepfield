import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Conversation, ConversationId, ProjectId } from "@deepfield/contracts";
import { toConversation } from "./mappers.js";
import type { ConversationRepository, ConversationRow, NewConversation } from "./types.js";

export function insertConversationRow(db: DatabaseSync, conversation: NewConversation): void {
  db.prepare(
    "INSERT INTO conversations(id, project_id, has_user_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    conversation.id,
    conversation.projectId,
    conversation.hasUserMessage ? 1 : 0,
    conversation.createdAt,
    conversation.updatedAt,
  );
}

export function createConversationRepository(db: DatabaseSync): ConversationRepository {
  return {
    listByProject(projectId: ProjectId): Conversation[] {
      const rows = db
        .prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at ASC")
        .all(projectId) as unknown as ConversationRow[];
      return rows.map(toConversation);
    },

    getOrCreateForProject(projectId: ProjectId): Conversation {
      const existing = db
        .prepare("SELECT * FROM conversations WHERE project_id = ?")
        .get(projectId) as unknown as ConversationRow | undefined;
      if (existing) {
        return toConversation(existing);
      }
      const conversationId = randomUUID() as ConversationId;
      const now = new Date().toISOString();
      try {
        insertConversationRow(db, {
          id: conversationId,
          projectId,
          hasUserMessage: false,
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        const raced = db
          .prepare("SELECT * FROM conversations WHERE project_id = ?")
          .get(projectId) as unknown as ConversationRow | undefined;
        if (raced) {
          return toConversation(raced);
        }
        throw error;
      }
      return {
        id: conversationId,
        projectId,
        hasUserMessage: false,
        createdAt: now,
        updatedAt: now,
      };
    },

    listRecent(): Conversation[] {
      const rows = db
        .prepare(
          "SELECT * FROM conversations WHERE has_user_message = 1 ORDER BY updated_at DESC",
        )
        .all() as unknown as ConversationRow[];
      return rows.map(toConversation);
    },

    markHasUserMessage(conversationId: ConversationId): void {
      db.prepare(
        "UPDATE conversations SET has_user_message = 1, updated_at = ? WHERE id = ?",
      ).run(new Date().toISOString(), conversationId);
    },
  };
}
