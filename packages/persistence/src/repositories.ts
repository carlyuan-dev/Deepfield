import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChatMessage,
  Conversation,
  ConversationId,
  CreateProjectInput,
  MessageId,
  Project,
  ProjectId,
  ProjectScope,
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

interface ProjectRow {
  id: string;
  industry: string;
  scope_json: string;
  status: "draft";
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  project_id: string;
  has_user_message: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface ActivityRow {
  id: string;
  project_id: string;
  type: string;
  source: string;
  importance: string;
  summary: string;
  payload_json: string | null;
  created_at: string;
}

interface NewConversation {
  id: ConversationId;
  projectId: ProjectId;
  hasUserMessage: boolean;
  createdAt: string;
  updatedAt: string;
}

function parseScope(scopeJson: string): ProjectScope {
  return JSON.parse(scopeJson) as ProjectScope;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id as ProjectId,
    industry: row.industry,
    scope: parseScope(row.scope_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id as ConversationId,
    projectId: row.project_id as ProjectId,
    hasUserMessage: row.has_user_message === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id as MessageId,
    conversationId: row.conversation_id as ConversationId,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

function toActivity(row: ActivityRow): ProjectActivityEvent {
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

function insertProjectRow(db: DatabaseSync, project: Project): void {
  db.prepare(
    "INSERT INTO projects(id, industry, scope_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    project.id,
    project.industry,
    JSON.stringify(project.scope),
    project.status,
    project.createdAt,
    project.updatedAt,
  );
}

function insertConversationRow(db: DatabaseSync, conversation: NewConversation): void {
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

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    projects: {
      createWithConversation(input: CreateProjectInput): Project {
        const now = new Date().toISOString();
        const project: Project = {
          id: randomUUID() as ProjectId,
          industry: input.industry,
          scope: input.scope,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        };
        const conversationId = randomUUID() as ConversationId;
        const activityId = randomUUID();

        db.exec("BEGIN IMMEDIATE;");
        try {
          insertProjectRow(db, project);
          insertConversationRow(db, {
            id: conversationId,
            projectId: project.id,
            hasUserMessage: false,
            createdAt: now,
            updatedAt: now,
          });
          db.prepare(
            "INSERT INTO project_activity_events(id, project_id, type, source, importance, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            activityId,
            project.id,
            "project.created",
            input.launchSource,
            "silent",
            `创建项目：${project.industry}`,
            null,
            now,
          );
          db.exec("COMMIT;");
        } catch (error) {
          db.exec("ROLLBACK;");
          throw error;
        }
        return project;
      },

      list(): Project[] {
        const rows = db
          .prepare("SELECT * FROM projects ORDER BY created_at ASC")
          .all() as unknown as ProjectRow[];
        return rows.map(toProject);
      },

      getById(projectId: ProjectId): Project | undefined {
        const row = db
          .prepare("SELECT * FROM projects WHERE id = ?")
          .get(projectId) as unknown as ProjectRow | undefined;
        return row ? toProject(row) : undefined;
      },
    },

    conversations: {
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
    },

    messages: {
      append(
        conversationId: ConversationId,
        role: "user" | "assistant",
        content: string,
      ): ChatMessage {
        const message: ChatMessage = {
          id: randomUUID() as MessageId,
          conversationId,
          role,
          content,
          createdAt: new Date().toISOString(),
        };
        db.prepare(
          "INSERT INTO messages(id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(message.id, message.conversationId, message.role, message.content, message.createdAt);
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
        const rows = db
          .prepare(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?",
          )
          .all(conversationId, limit) as unknown as MessageRow[];
        return rows.map(toMessage);
      },
    },

    activities: {
      append(
        projectId: ProjectId,
        type: string,
        source: string,
        importance: string,
        summary: string,
        payload?: unknown,
      ): ProjectActivityEvent {
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        const payloadJson = payload === undefined ? null : JSON.stringify(payload);
        db.prepare(
          "INSERT INTO project_activity_events(id, project_id, type, source, importance, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(id, projectId, type, source, importance, summary, payloadJson, createdAt);
        if (payload === undefined) {
          return { id, projectId, type, source, importance, summary, createdAt };
        }
        return { id, projectId, type, source, importance, summary, payload, createdAt };
      },

      listByProject(projectId: ProjectId): ProjectActivityEvent[] {
        const rows = db
          .prepare(
            "SELECT * FROM project_activity_events WHERE project_id = ? ORDER BY created_at ASC",
          )
          .all(projectId) as unknown as ActivityRow[];
        return rows.map(toActivity);
      },
    },
  };
}
