import type { ConversationId } from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import type { ConversationReader } from "@deepfield/utility-tools";

export type ConversationRepositories = Pick<Repositories, "conversations" | "messages">;

const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_SNIPPET_LENGTH = 240;

function truncate(text: string, maximum: number): string {
  const characters = Array.from(text);
  if (characters.length <= maximum) return text;
  return `${characters.slice(0, maximum - 1).join("")}…`;
}

function compact(text: string, maximum: number): string {
  return truncate(text.replace(/\s+/gu, " ").trim(), maximum);
}

function matchingSnippet(text: string, query: string): string | undefined {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const matchAt = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (matchAt < 0) return undefined;
  const start = Math.max(0, matchAt - 80);
  const prefix = start > 0 ? "…" : "";
  const excerpt = normalized.slice(start, start + MAX_SNIPPET_LENGTH - prefix.length);
  return truncate(`${prefix}${excerpt}`, MAX_SNIPPET_LENGTH);
}

export function createRepositoryConversationReader(
  repositories: ConversationRepositories,
): ConversationReader {
  return {
    async listRecent(limit) {
      return repositories.conversations.listRecent().slice(0, limit).map((conversation) => ({
        id: conversation.id,
        title: compact(conversation.title, MAX_TITLE_LENGTH),
        updatedAt: conversation.updatedAt,
      }));
    },

    async read(conversationId, limit) {
      const id = conversationId as ConversationId;
      const conversation = repositories.conversations.getById(id);
      if (conversation === undefined) return undefined;
      return {
        conversationId: conversation.id,
        title: compact(conversation.title, MAX_TITLE_LENGTH),
        messages: repositories.messages.listByConversation(id, limit).map((message) => ({
          role: message.role,
          content: truncate(message.content, MAX_MESSAGE_LENGTH),
        })),
      };
    },

    async search(query, maxResults) {
      const results = [];
      for (const conversation of repositories.conversations.listRecent()) {
        let snippet = matchingSnippet(conversation.title, query);
        if (snippet === undefined) {
          for (const message of repositories.messages.listByConversation(conversation.id)) {
            snippet = matchingSnippet(message.content, query);
            if (snippet !== undefined) break;
          }
        }
        if (snippet === undefined) continue;
        results.push({
          conversationId: conversation.id,
          title: compact(conversation.title, MAX_TITLE_LENGTH),
          snippet,
          updatedAt: conversation.updatedAt,
        });
        if (results.length >= maxResults) break;
      }
      return results;
    },
  };
}
