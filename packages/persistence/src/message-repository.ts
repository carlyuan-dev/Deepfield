import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChatMessage, ConversationId, MessageId } from "./legacy-company-contracts/index.js";
import { toMessage } from "./mappers.js";
import type { MessageRepository, MessageRow } from "./types.js";

export function createMessageRepository(db: DatabaseSync): MessageRepository {
  return {
    append(
      conversationId: ConversationId,
      role: "user" | "assistant",
      content: string,
      requestId?: string,
    ): ChatMessage {
      const message: ChatMessage = {
        id: randomUUID() as MessageId,
        conversationId,
        role,
        content,
        createdAt: new Date().toISOString(),
        ...(requestId === undefined ? {} : { requestId }),
      };
      db.prepare(
        "INSERT INTO messages(id, conversation_id, role, content, created_at, request_id) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(message.id, message.conversationId, message.role, message.content, message.createdAt, requestId ?? null);
      return message;
    },

    listByConversation(conversationId: ConversationId, limit?: number): ChatMessage[] {
      if (limit === undefined) {
        const rows = db
          .prepare(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
          )
          .all(conversationId) as unknown as MessageRow[];
        return rows.map(toMessage);
      }
      if (!Number.isInteger(limit) || limit <= 0) {
        throw new RangeError(`limit must be a positive integer, got ${JSON.stringify(limit)}`);
      }
      const rows = db
        .prepare(
          `SELECT * FROM (
             SELECT id, conversation_id, role, content, created_at, request_id, rowid
             FROM messages
             WHERE conversation_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
           )
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(conversationId, limit) as unknown as MessageRow[];
      return rows.map(toMessage);
    },
  };
}
