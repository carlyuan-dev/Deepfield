import type {
  AgentContextSnapshot,
  MessageId,
  ProjectId,
  ProjectScope,
} from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";

export class ContextBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBuilderError";
  }
}

const SCOPE_KEYS = [
  "focus",
  "geography",
  "timeRange",
  "exclusions",
  "customRequirements",
] as const;

export function canonicalScopeJson(scope: ProjectScope): string {
  const record: Record<string, unknown> = {};
  for (const key of SCOPE_KEYS) {
    const value = scope[key];
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return JSON.stringify(record);
}

export function buildSystemPrompt(industry: string, scope: ProjectScope): string {
  return [
    "你是 Deepfield 的主 Agent。",
    `当前项目：${industry}`,
    `项目范围：${canonicalScopeJson(scope)}`,
    "你当前处于普通 Chat，不得声称已经联网搜索或执行行业研究。",
    "需要持久化行业研究时，应建议用户进入“行业研究” Capability。",
  ].join("\n");
}

export interface BuildContextOptions {
  excludeMessageId?: MessageId;
}

const RECENT_MESSAGE_LIMIT = 40;

export class ContextBuilder {
  constructor(private readonly repositories: Repositories) {}

  build(projectId: ProjectId, options: BuildContextOptions = {}): AgentContextSnapshot {
    const project = this.repositories.projects.getById(projectId);
    if (!project) {
      throw new ContextBuilderError("project not found");
    }
    const conversation = this.repositories.conversations.listByProject(projectId)[0];
    if (!conversation) {
      throw new ContextBuilderError("conversation not found");
    }

    // Read the latest RECENT_MESSAGE_LIMIT + 1 so that excluding the current
    // user message still leaves RECENT_MESSAGE_LIMIT messages.
    const recent = this.repositories.messages.listByConversation(
      conversation.id,
      RECENT_MESSAGE_LIMIT + 1,
    );
    const filtered =
      options.excludeMessageId === undefined
        ? recent
        : recent.filter((message) => message.id !== options.excludeMessageId);
    const latest = filtered.slice(-RECENT_MESSAGE_LIMIT);

    return {
      projectId: project.id,
      conversationId: conversation.id,
      systemPrompt: buildSystemPrompt(project.industry, project.scope),
      messages: latest.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: Date.parse(message.createdAt),
      })),
    };
  }
}
