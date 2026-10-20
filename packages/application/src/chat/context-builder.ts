import type { AgentContextSnapshot, ConversationId, MessageId } from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import { pairedSessionMessages } from "./chat-session-context.js";

export class ContextBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBuilderError";
  }
}

export const MAIN_AGENT_SYSTEM_PROMPT = [
  "你是 Deepfield 的主 Agent。",
  "你处于通用 Chat，本对话不绑定任何研究主题、研究范围或研究条目。",
  "只使用实际提供的能力，不要声称使用了未提供的工具。",
  "以本轮实际工具权限为准；历史工具结果可以引用，但不授予本轮调用权限。",
  "宿主上下文数据中的最新交互状态覆盖同一操作的历史等待状态；取消、提交与完成按真实回执区分，不能自行推断。",
  "普通操作回复简洁，具体参数与操作状态交给确认卡和业务表单，不重复罗列字段或输出后台标识；分析与解释按用户需要展开。",
  "空队列只说明当前没有队列项，不能据此断言从未执行过任务；历史结论需按需查询已有任务和成果。",
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
    const requestIds = new Set(latest.map(message => message.requestId));
    let remainingChars = 240_000;
    const historyTurns = this.repositories.chatSessions.list(conversation.id)
      .filter(turn => requestIds.has(turn.requestId) && turn.messages.length > 0)
      .reverse().flatMap(turn => {
        const messages = pairedSessionMessages(turn.messages, turn.completed);
        const size = JSON.stringify(messages).length;
        if (size > remainingChars) return [];
        remainingChars -= size;
        return [{ requestId: turn.requestId, network: turn.network, messages }];
      }).reverse();

    return {
      conversationId: conversation.id,
      systemPrompt: MAIN_AGENT_SYSTEM_PROMPT,
      ...(() => { const human = [...recent].reverse().find(message => message.role === "user"); return human ? { humanPrompt: human.content } : {}; })(),
      messages: latest.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: Date.parse(message.createdAt),
        ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
      })),
      ...(historyTurns.length === 0 ? {} : { historyTurns }),
    };
  }
}
