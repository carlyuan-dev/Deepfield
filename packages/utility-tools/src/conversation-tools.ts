import { Type } from "typebox";
import {
  HostConversationDetailSchema,
  HostConversationListPayloadSchema,
  HostConversationSearchPayloadSchema,
  type HostConversationDetail,
  type HostConversationSearchResult,
  type HostConversationSummary,
} from "@deepfield/contracts";
import {
  ToolExecutionError,
  type ToolDefinition,
} from "@deepfield/tool-platform";

export type ConversationToolName =
  | "list_conversations"
  | "read_conversation"
  | "search_conversations";

export interface ConversationReader {
  listRecent(limit: number): Promise<HostConversationSummary[]>;
  read(conversationId: string, limit: number): Promise<HostConversationDetail | undefined>;
  search(query: string, maxResults: number): Promise<HostConversationSearchResult[]>;
}

const listInputSchema = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })) },
  { additionalProperties: false },
);
const readInputSchema = Type.Object(
  {
    conversationId: Type.String({ minLength: 1, maxLength: 200 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
const searchInputSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 200 }),
    maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  },
  { additionalProperties: false },
);

function limitOrDefault(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new ToolExecutionError("invalid_input");
  }
  return limit;
}

export function createConversationToolDefinitions(
  reader: ConversationReader,
): readonly [
  ToolDefinition<typeof listInputSchema, typeof HostConversationListPayloadSchema>,
  ToolDefinition<typeof readInputSchema, typeof HostConversationDetailSchema>,
  ToolDefinition<typeof searchInputSchema, typeof HostConversationSearchPayloadSchema>,
] {
  const listDefinition: ToolDefinition<
    typeof listInputSchema,
    typeof HostConversationListPayloadSchema
  > = {
    identity: { name: "list_conversations", version: 1 },
    label: "List Conversations",
    description: "List recent conversations that contain user messages.",
    inputSchema: listInputSchema,
    outputSchema: HostConversationListPayloadSchema,
    effect: "conversation.read",
    timeoutMs: 5000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 4,
    meter: { category: "none", countsBytes: false, countsTime: true },
    execute: async ({ limit }) => ({
      conversations: await reader.listRecent(limitOrDefault(limit, 10, 30)),
    }),
  };
  const readDefinition: ToolDefinition<
    typeof readInputSchema,
    typeof HostConversationDetailSchema
  > = {
    identity: { name: "read_conversation", version: 1 },
    label: "Read Conversation",
    description: "Read a bounded number of user and assistant messages from one conversation.",
    inputSchema: readInputSchema,
    outputSchema: HostConversationDetailSchema,
    effect: "conversation.read",
    timeoutMs: 5000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 4,
    meter: { category: "none", countsBytes: false, countsTime: true },
    execute: async ({ conversationId, limit }) => {
      const conversation = await reader.read(
        conversationId,
        limitOrDefault(limit, 40, 100),
      );
      if (conversation === undefined) {
        throw new ToolExecutionError("invalid_input");
      }
      return conversation;
    },
  };
  const searchDefinition: ToolDefinition<
    typeof searchInputSchema,
    typeof HostConversationSearchPayloadSchema
  > = {
    identity: { name: "search_conversations", version: 1 },
    label: "Search Conversations",
    description: "Search conversation titles and message text using a local text match.",
    inputSchema: searchInputSchema,
    outputSchema: HostConversationSearchPayloadSchema,
    effect: "conversation.read",
    timeoutMs: 5000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 4,
    meter: { category: "none", countsBytes: false, countsTime: true },
    execute: async ({ query, maxResults }) => {
      const normalizedQuery = query.trim();
      if (normalizedQuery.length === 0 || normalizedQuery.length > 200) {
        throw new ToolExecutionError("invalid_input");
      }
      return {
        results: await reader.search(
          normalizedQuery,
          limitOrDefault(maxResults, 10, 30),
        ),
      };
    },
  };
  return [listDefinition, readDefinition, searchDefinition];
}
