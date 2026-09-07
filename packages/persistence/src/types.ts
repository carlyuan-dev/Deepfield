import type {
  ChatMessage,
  Conversation,
  ConversationId,
  CreateProjectInput,
  MessageId,
  Project,
  ProjectId,
} from "@deepfield/contracts";

export interface ProjectActivityEvent {
  id: string;
  projectId: string;
  type: string;
  source: string;
  importance: string;
  summary: string;
  payload?: unknown;
  createdAt: string;
}

export interface ProjectRepository {
  create(input: CreateProjectInput): Project;
  list(): Project[];
  getById(projectId: ProjectId): Project | undefined;
}

export interface ConversationRepository {
  create(): Conversation;
  getOrCreateDraft(): Conversation;
  getById(conversationId: ConversationId): Conversation | undefined;
  listRecent(): Conversation[];
  activate(conversationId: ConversationId, title: string): Conversation;
}

export interface MessageRepository {
  append(conversationId: ConversationId, role: "user" | "assistant", content: string): ChatMessage;
  listByConversation(conversationId: ConversationId, limit?: number): ChatMessage[];
}

export interface ActivityRepository {
  append(
    projectId: ProjectId,
    type: string,
    source: string,
    importance: string,
    summary: string,
    payload?: unknown,
  ): ProjectActivityEvent;
  listByProject(projectId: ProjectId): ProjectActivityEvent[];
}

export type ToolExecutionStatus = "running" | "completed" | "failed" | "cancelled";

export interface ToolExecution {
  id: string;
  traceId: string;
  projectId?: string;
  actor: string;
  toolName: string;
  toolVersion: number;
  status: ToolExecutionStatus;
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
}

export interface ToolExecutionRepository {
  start(record: ToolExecutionStart): void;
  finish(record: ToolExecutionFinish): void;
  getById(id: string): ToolExecution | undefined;
  listRecent(limit: number): ToolExecution[];
}

export interface Repositories {
  projects: ProjectRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  activities: ActivityRepository;
  toolExecutions: ToolExecutionRepository;
  runInTransaction<T>(work: () => T): T;
}

export interface NewConversation {
  id: ConversationId;
  title: string;
  hasUserMessage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRow {
  id: string;
  industry: string;
  scope_json: string;
  status: "draft";
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  has_user_message: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface ActivityRow {
  id: string;
  project_id: string;
  type: string;
  source: string;
  importance: string;
  summary: string;
  payload_json: string | null;
  created_at: string;
}

export interface ToolExecutionRow {
  id: string;
  trace_id: string;
  project_id: string | null;
  actor: string;
  tool_name: string;
  tool_version: number;
  status: ToolExecutionStatus;
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
