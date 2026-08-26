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
  createWithConversation(input: CreateProjectInput): Project;
  list(): Project[];
  getById(projectId: ProjectId): Project | undefined;
}

export interface ConversationRepository {
  listByProject(projectId: ProjectId): Conversation[];
  getOrCreateForProject(projectId: ProjectId): Conversation;
  listRecent(): Conversation[];
  markHasUserMessage(conversationId: ConversationId): void;
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

export interface Repositories {
  projects: ProjectRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  activities: ActivityRepository;
}

export interface NewConversation {
  id: ConversationId;
  projectId: ProjectId;
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
  project_id: string;
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
