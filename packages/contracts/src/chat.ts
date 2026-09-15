import { Type, type Static } from "typebox";
import type { ConversationId, MessageId } from "./ids.js";
import type { Conversation } from "./conversations.js";
import { LlmRuntimeSnapshotSchema, SearchRuntimeSnapshotSchema, ToolAccessPolicySchema } from "./settings.js";

export const DEFAULT_DEEPSEEK_MODEL_ID = "deepseek-v4-flash" as const;

export const AgentContextMessageSchema = Type.Object(
  {
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    content: Type.String(),
    timestamp: Type.Number(),
  },
  { additionalProperties: false },
);
export type AgentContextMessage = Static<typeof AgentContextMessageSchema>;

export const AgentContextSnapshotSchema = Type.Object(
  {
    conversationId: Type.String(),
    systemPrompt: Type.String(),
    finalizationSystemPrompt: Type.Optional(Type.String()),
    messages: Type.Array(AgentContextMessageSchema),
  },
  { additionalProperties: false },
);
export type AgentContextSnapshot = Static<typeof AgentContextSnapshotSchema>;

export const ChatRequestOptionsSchema = Type.Object(
  {
    webSearch: Type.Boolean(),
    skillName: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type ChatRequestOptions = Static<typeof ChatRequestOptionsSchema>;

export const AgentWorkerRequestSchema = Type.Object(
  {
    requestId: Type.String(),
    kind: Type.Literal("chat.prompt"),
    prompt: Type.String(),
    context: AgentContextSnapshotSchema,
    options: ChatRequestOptionsSchema,
    llm: LlmRuntimeSnapshotSchema,
    search: Type.Optional(SearchRuntimeSnapshotSchema),
    toolAccess: ToolAccessPolicySchema,
  },
  { additionalProperties: false },
);
export type AgentWorkerRequest = Static<typeof AgentWorkerRequestSchema>;

export const ToolActivityStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("skipped"),
  Type.Literal("reused"),
]);
export type ToolActivityStatus = Static<typeof ToolActivityStatusSchema>;

const toolActivityFields = {
  requestId: Type.String(),
  type: Type.Literal("tool_activity"),
  callKey: Type.String({ minLength: 1, maxLength: 64 }),
  name: Type.String({ minLength: 1, maxLength: 48 }),
  summary: Type.Optional(Type.String({ maxLength: 96 })),
  errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  agentTurnIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  batchId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
};

const ToolActivityEventSchema = Type.Union([
  Type.Object(
    {
      ...toolActivityFields,
      status: Type.Union([
        Type.Literal("running"),
        Type.Literal("completed"),
        Type.Literal("failed"),
      ]),
      budgetConsumed: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...toolActivityFields,
      status: Type.Union([Type.Literal("skipped"), Type.Literal("reused")]),
      budgetConsumed: Type.Literal(false),
    },
    { additionalProperties: false },
  ),
]);

export const AgentWorkerEventSchema = Type.Union([
  Type.Object(
    {
      requestId: Type.String(),
      type: Type.Literal("started"),
      skillName: Type.Optional(Type.String({ minLength: 1 })),
      webSearch: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { requestId: Type.String(), type: Type.Literal("text_delta"), delta: Type.String() },
    { additionalProperties: false },
  ),
  ToolActivityEventSchema,
  Type.Object(
    { requestId: Type.String(), type: Type.Literal("completed"), text: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      requestId: Type.String(),
      type: Type.Literal("failed"),
      code: Type.String(),
      message: Type.String(),
    },
    { additionalProperties: false },
  ),
]);
export type AgentWorkerEvent = Static<typeof AgentWorkerEventSchema>;

export interface ChatMessage {
  id: MessageId;
  conversationId: ConversationId;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  requestId?: string;
  toolExecutions?: ChatToolExecution[];
}

export interface ChatToolExecution {
  callKey: string;
  name: string;
  status: ToolActivityStatus;
  agentTurnIndex?: number;
  batchId?: string;
  toolCallId?: string;
  budgetConsumed?: boolean;
  durationMs?: number;
  errorCode?: string;
}

export interface ChatSendResult {
  requestId: string;
  conversation: Conversation;
}
