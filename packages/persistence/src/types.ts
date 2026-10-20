import type { ChatMessage, Conversation, ConversationId } from "@deepfield/contracts";
export interface ConversationRepository {
  create(): Conversation;
  getOrCreateDraft(): Conversation;
  getById(conversationId: ConversationId): Conversation | undefined;
  listRecent(): Conversation[];
  activate(conversationId: ConversationId, title: string): Conversation;
  updateTitle(conversationId: ConversationId, title: string): Conversation;
  setWebSearchEnabled(conversationId: ConversationId, enabled: boolean): Conversation;
  delete(conversationId: ConversationId): boolean;
}

export interface MessageRepository {
  append(conversationId: ConversationId, role: "user" | "assistant", content: string, requestId?: string): ChatMessage;
  listByConversation(conversationId: ConversationId, limit?: number): ChatMessage[];
}

export type ToolExecutionStatus = "running" | "completed" | "failed" | "cancelled" | "skipped" | "reused";

export interface ToolExecution {
  id: string;
  traceId: string;
  projectId?: string;
  actor: string;
  toolName: string;
  toolVersion: number;
  status: ToolExecutionStatus;
  agentTurnIndex?: number;
  batchId?: string;
  toolCallId?: string;
  budgetConsumed?: boolean;
  inputSummary?: unknown;
  outputSummary?: unknown;
  errorCode?: string;
  attempts: number;
  retries: number;
  bytesReceived: number;
  resultCount: number;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

export interface ToolExecutionStart {
  id: string;
  traceId: string;
  projectId?: string;
  actor: string;
  toolName: string;
  toolVersion: number;
  agentTurnIndex?: number;
  batchId?: string;
  toolCallId?: string;
  budgetConsumed?: boolean;
  inputSummary?: unknown;
  startedAt: string;
}

export interface ToolExecutionFinish {
  id: string;
  status: "completed" | "failed" | "cancelled";
  outputSummary?: unknown;
  errorCode?: string;
  attempts: number;
  retries: number;
  bytesReceived: number;
  resultCount: number;
  finishedAt: string;
  durationMs?: number;
  budgetConsumed?: boolean;
}

export interface ToolExecutionSynthetic {
  id: string;
  traceId: string;
  projectId?: string;
  actor: string;
  toolName: string;
  toolVersion: number;
  status: "skipped" | "reused" | "failed";
  agentTurnIndex: number;
  batchId: string;
  toolCallId: string;
  errorCode?: string;
  attempts: 0;
  budgetConsumed: false;
  startedAt: string;
  finishedAt: string;
}

export interface ToolExecutionRepository {
  start(record: ToolExecutionStart): void;
  finish(record: ToolExecutionFinish): void;
  recordSynthetic(record: ToolExecutionSynthetic): void;
  getById(id: string): ToolExecution | undefined;
  listRecent(limit: number): ToolExecution[];
  listByConversation(conversationId: ConversationId, limit?: number): ToolExecution[];
}

export interface ToolExecutionCleanupRepository {
  deleteByTraceIds(traceIds: readonly string[]): number;
}

export interface Repositories {
  chatInteractions: ReturnType<typeof import("./chat-interaction-repository.js").createChatInteractionRepository>;
  chatCapabilities: ReturnType<typeof import("./chat-capability-repository.js").createChatCapabilityRepository>;
  capabilityInvocations: import("./capability-invocation-repository.js").InvocationRepository;
  chatSessions: ReturnType<typeof import("./chat-session-repository.js").createChatSessionRepository>;
  conversations: ConversationRepository;
  messages: MessageRepository;
  toolExecutions: ToolExecutionRepository & ToolExecutionCleanupRepository;
  runInTransaction<T>(work: () => T): T;
}

export interface NewConversation {
  id: ConversationId;
  title: string;
  hasUserMessage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  has_user_message: number;
  web_search_enabled: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  request_id: string | null;
}

export interface ToolExecutionRow {
  id: string;
  trace_id: string;
  project_id: string | null;
  actor: string;
  tool_name: string;
  tool_version: number;
  status: ToolExecutionStatus;
  agent_turn_index: number | null;
  batch_id: string | null;
  tool_call_id: string | null;
  budget_consumed: number | null;
  input_summary_json: string | null;
  output_summary_json: string | null;
  error_code: string | null;
  attempts: number;
  retries: number;
  bytes_received: number;
  result_count: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}
