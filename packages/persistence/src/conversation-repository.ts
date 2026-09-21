import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Conversation, ConversationId } from "./legacy-company-contracts/index.js";
import { toConversation } from "./mappers.js";
import type { ConversationRepository, ConversationRow, NewConversation } from "./types.js";
import { runInTransaction } from "./transactions.js";

export const BLANK_CONVERSATION_TITLE = "新对话";

export function insertConversationRow(db: DatabaseSync, conversation: NewConversation): void {
  db.prepare(
    "INSERT INTO conversations(id, title, has_user_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    conversation.id,
    conversation.title,
    conversation.hasUserMessage ? 1 : 0,
    conversation.createdAt,
    conversation.updatedAt,
  );
}

export function createConversationRepository(db: DatabaseSync): ConversationRepository {
  const insertBlank = (): Conversation => {
    const conversationId = randomUUID() as ConversationId;
    const now = new Date().toISOString();
    insertConversationRow(db, {
      id: conversationId,
      title: BLANK_CONVERSATION_TITLE,
      hasUserMessage: false,
      createdAt: now,
      updatedAt: now,
    });
    return {
      id: conversationId,
      webSearchEnabled: false,
      title: BLANK_CONVERSATION_TITLE,
      hasUserMessage: false,
      createdAt: now,
      updatedAt: now,
    };
  };

  return {
    create(): Conversation {
      return insertBlank();
    },

    getOrCreateDraft(): Conversation {
      const existing = db
        .prepare(
          "SELECT * FROM conversations WHERE has_user_message = 0 ORDER BY created_at DESC, updated_at DESC LIMIT 1",
        )
        .get() as unknown as ConversationRow | undefined;
      return existing ? toConversation(existing) : insertBlank();
    },

    getById(conversationId: ConversationId): Conversation | undefined {
      const row = db
        .prepare("SELECT * FROM conversations WHERE id = ?")
        .get(conversationId) as unknown as ConversationRow | undefined;
      return row ? toConversation(row) : undefined;
    },

    listRecent(): Conversation[] {
      // rowid DESC is the stable tie-breaker when two updates share the same
      // millisecond timestamp (later-inserted rows win).
      const rows = db
        .prepare(
          "SELECT * FROM conversations WHERE has_user_message = 1 ORDER BY updated_at DESC, rowid DESC",
        )
        .all() as unknown as ConversationRow[];
      return rows.map(toConversation);
    },

    activate(conversationId: ConversationId, title: string): Conversation {
      db.prepare(
        "UPDATE conversations SET has_user_message = 1, title = ?, updated_at = ? WHERE id = ?",
      ).run(title, new Date().toISOString(), conversationId);
      const updated = db
        .prepare("SELECT * FROM conversations WHERE id = ?")
        .get(conversationId) as unknown as ConversationRow | undefined;
      if (!updated) {
        throw new Error(`conversation not found: ${conversationId}`);
      }
      return toConversation(updated);
    },

    updateTitle(conversationId: ConversationId, title: string): Conversation {
      db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, conversationId);
      const updated = db
        .prepare("SELECT * FROM conversations WHERE id = ?")
        .get(conversationId) as unknown as ConversationRow | undefined;
      if (!updated) {
        throw new Error(`conversation not found: ${conversationId}`);
      }
      return toConversation(updated);
    },

    setWebSearchEnabled(conversationId: ConversationId, enabled: boolean): Conversation {
      db.prepare("UPDATE conversations SET web_search_enabled = ? WHERE id = ?").run(enabled ? 1 : 0, conversationId);
      const updated = db.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as unknown as ConversationRow | undefined;
      if (!updated) throw new Error(`conversation not found: ${conversationId}`);
      return toConversation(updated);
    },

    delete(conversationId: ConversationId): boolean {
      return runInTransaction(db, () => {
        db.prepare(
          `DELETE FROM tool_executions
           WHERE trace_id IN (
             SELECT request_id FROM messages
             WHERE conversation_id = ? AND request_id IS NOT NULL
           )`,
        ).run(conversationId);
        const result = db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
        return result.changes > 0;
      });
    },
  };
}
