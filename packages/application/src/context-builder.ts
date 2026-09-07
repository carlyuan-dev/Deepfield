import type { AgentContextSnapshot, ConversationId, MessageId } from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";

export class ContextBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBuilderError";
  }
}

export const MAIN_AGENT_SYSTEM_PROMPT = [
  "你是 Deepfield 的主 Agent。",
  "你处于普通 Chat：回答必须基于已有知识与对话历史，不得声称已经联网搜索或执行行业研究。",
  "本对话不绑定任何行业、研究范围或研究条目；需要行业研究等业务能力时，应建议用户使用左侧“工作流”中的 Capability。",
].join("\n");

export interface BuildContextOptions {
  excludeMessageId?: MessageId;
}

const RECENT_MESSAGE_LIMIT = 40;

export class ContextBuilder {
  constructor(private readonly repositories: Repositories) {}

  build(conversationId: ConversationId, options: BuildContextOptions = {}): AgentContextSnapshot {
    const conversation = this.repositories.conversations.getById(conversationId);
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
      conversationId: conversation.id,
      systemPrompt: MAIN_AGENT_SYSTEM_PROMPT,
      messages: latest.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: Date.parse(message.createdAt),
      })),
    };
  }
}
