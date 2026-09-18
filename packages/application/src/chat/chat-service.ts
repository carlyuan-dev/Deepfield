import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
  type ChatMessage,
  type ChatRequestOptions,
  type ChatSendResult,
  type Conversation,
  type ConversationId,
  type MessageId,
} from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import type { ContextBuilder } from "./context-builder.js";
import type { AgentWorkerPort, ConversationTitleGenerator, RuntimeProfileResolver } from "../ports.js";

export const DEEPSEEK_KEY_NAME = "deepseek.apiKey";
export const OFFLINE_CHAT_POLICY = { network: "disabled", maxAgentTurns: 6, maxSearchCalls: 0, maxFetchCalls: 0 } as const;
export const WEB_CHAT_POLICY = { network: "enabled", maxAgentTurns: 6, maxSearchCalls: 4, maxFetchCalls: 3 } as const;

export type { ChatSendResult } from "@deepfield/contracts";

export class ChatServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatServiceError";
  }
}

export interface ChatServiceOptions {
  onConsumptionFinished?: (requestId: string) => void;
  titleGenerator?: ConversationTitleGenerator;
}

const FAILED_MESSAGE = "chat request failed";

const DEFAULT_CHAT_OPTIONS: ChatRequestOptions = { webSearch: false };

/** Deterministic first-message title: trimmed single-spaced text, 28 chars max. */
export function titleFromFirstMessage(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  return characters.length <= 28 ? normalized : `${characters.slice(0, 28).join("")}…`;
}

export class ChatService {
  private readonly conversationUpdateListeners = new Set<(conversation: Conversation) => void>();

  constructor(
    private readonly repositories: Repositories,
    private readonly contextBuilder: ContextBuilder,
    private readonly profiles: RuntimeProfileResolver,
    private readonly worker: AgentWorkerPort,
    private readonly options: ChatServiceOptions = {},
  ) {}

  async send(
    conversationId: string,
    content: string,
    requestId: string,
    onEvent: (event: AgentWorkerEvent) => void,
    options: ChatRequestOptions = DEFAULT_CHAT_OPTIONS,
  ): Promise<ChatSendResult> {
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new ChatServiceError("content must not be blank");
    }
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new ChatServiceError("request id must not be blank");
    }
    let llm;
    try { llm = await this.profiles.resolveActiveLlm(); }
    catch { throw new ChatServiceError("请先在设置中配置并启用 LLM Profile"); }
    let search;
    if (options.webSearch) {
      try { search = await this.profiles.resolveActiveSearch(); }
      catch { throw new ChatServiceError("请先在设置中配置并启用 Search Profile"); }
    }
    const conversation = this.repositories.conversations.getById(conversationId as ConversationId);
    if (!conversation) {
      throw new ChatServiceError("conversation not found");
    }

    let userMessage: ChatMessage;
    let updated: Conversation = conversation;
    try {
      userMessage = this.repositories.runInTransaction(() => {
        const message = this.repositories.messages.append(conversation.id, "user", content, requestId);
        // Every persisted user message refreshes the Conversation's recency;
        // the deterministic title is only generated for the first message.
        updated = this.repositories.conversations.activate(
          conversation.id,
          conversation.hasUserMessage ? conversation.title : titleFromFirstMessage(content),
        );
        return message;
      });
    } catch {
      throw new ChatServiceError("failed to persist user message");
    }
    const context = this.contextBuilder.build(conversation.id, { excludeMessageId: userMessage.id });

    const request: AgentWorkerRequest = {
      requestId,
      kind: "chat.prompt",
      prompt: content,
      context,
      options,
      llm,
      ...(search === undefined ? {} : { search }),
      toolAccess: options.webSearch ? WEB_CHAT_POLICY : OFFLINE_CHAT_POLICY,
    };

    void this.consume(request, conversation.id, onEvent).catch(() => {
      // Background consumption must never surface as an unhandled rejection.
    });
    if (!conversation.hasUserMessage && this.options.titleGenerator !== undefined) {
      void this.generateTitle(conversation.id, content).catch(() => {
        // The deterministic title already returned by activation remains the fallback.
      });
    }
    return { requestId, conversation: updated };
  }

  subscribeConversationUpdates(listener: (conversation: Conversation) => void): () => void {
    this.conversationUpdateListeners.add(listener);
    return () => this.conversationUpdateListeners.delete(listener);
  }

  listMessages(conversationId: string): ChatMessage[] {
    const conversation = this.repositories.conversations.getById(conversationId as ConversationId);
    if (!conversation) {
      throw new ChatServiceError("conversation not found");
    }
    const messages = this.repositories.messages.listByConversation(conversation.id);
    const tools = this.repositories.toolExecutions.listByConversation(conversation.id);
    const sessions = new Map(this.repositories.chatSessions.list(conversation.id).map(turn => [turn.requestId, turn]));
    const byRequest = new Map<string, typeof tools>();
    for (const tool of tools) {
      const current = byRequest.get(tool.traceId) ?? [];
      current.push(tool); byRequest.set(tool.traceId, current);
    }
    const displayed = messages.flatMap((message): ChatMessage[] => {
      const turn = message.requestId === undefined ? undefined : sessions.get(message.requestId);
      if (message.role !== "user" || turn === undefined || turn.completed || (!turn.failed && turn.activities.length === 0) || messages.some(item => item.role === "assistant" && item.requestId === turn.requestId)) return [message];
      return [message, { id: `interrupted-${turn.requestId}` as MessageId, conversationId: conversation.id, requestId: turn.requestId, role: "assistant", content: "", status: "failed", createdAt: message.createdAt }];
    });
    return displayed.map((message) => {
      if (message.role !== "assistant" || message.requestId === undefined) return message;
      const associated = byRequest.get(message.requestId) ?? [];
      const projected = (sessions.get(message.requestId)?.activities ?? []).map(activity => message.status === "failed" && activity.status === "running" ? { ...activity, status: "failed" as const } : activity);
      return {
        ...message,
        toolExecutions: [...projected, ...associated.filter(tool => !projected.some(activity =>
          activity.callKey === tool.id || (activity.toolCallId !== undefined && activity.toolCallId === tool.toolCallId),
        )).map((tool) => {
          const status = tool.status === "cancelled" ? "failed" as const : tool.status;
          return {
            callKey: tool.id,
            name: tool.toolName,
            status,
            ...(tool.agentTurnIndex === undefined ? {} : { agentTurnIndex: tool.agentTurnIndex }),
            ...(tool.batchId === undefined ? {} : { batchId: tool.batchId }),
            ...(tool.toolCallId === undefined ? {} : { toolCallId: tool.toolCallId }),
            ...(tool.budgetConsumed === undefined
              ? {}
              : { budgetConsumed: tool.budgetConsumed }),
            ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
            ...(tool.errorCode === undefined ? {} : { errorCode: tool.errorCode }),
          };
        })],
      };
    });
  }

  private async consume(
    request: AgentWorkerRequest,
    conversationId: ConversationId,
    onEvent: (event: AgentWorkerEvent) => void,
  ): Promise<void> {
    let settled = false;

    const safeEmit = (event: AgentWorkerEvent): void => {
      try {
        onEvent(event);
      } catch {
        // The renderer sink is gone; drop events but keep consuming safely.
      }
    };

    const fail = (code: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      try { this.repositories.chatSessions.fail(conversationId, request.requestId); } catch { /* Preserve the original failure. */ }
      safeEmit({ requestId: request.requestId, type: "failed", code, message: FAILED_MESSAGE });
    };

    try {
      let stream: AsyncIterable<AgentWorkerEvent>;
      try {
        stream = this.worker.send(request);
      } catch {
        fail("worker_send_failed");
        return;
      }

      for await (const event of stream) {
        if (settled) {
          continue;
        }
        if (!Value.Check(AgentWorkerEventSchema, event)) {
          continue;
        }
        if (event.requestId !== request.requestId) continue;
        if (event.type === "transcript_checkpoint" || event.type === "tool_activity") {
          try {
            if (event.type === "transcript_checkpoint") {
              this.repositories.chatSessions.checkpoint(conversationId, request.requestId, request.toolAccess.network, event.messages);
            } else {
              this.repositories.chatSessions.activity(conversationId, request.requestId, request.toolAccess.network, event);
            }
          } catch { fail("chat_persistence_failed"); return; }
          if (event.type === "transcript_checkpoint") continue;
        }
        if (event.type === "completed") {
          try {
            // Standalone Chat has no CapabilityItem: persist the assistant reply only.
            this.repositories.runInTransaction(() => {
              this.repositories.messages.append(conversationId, "assistant", event.text, request.requestId);
              this.repositories.chatSessions.complete(conversationId, request.requestId);
            });
          } catch {
            fail("chat_persistence_failed");
            return;
          }
          settled = true;
          safeEmit(event);
          return;
        }
        if (event.type === "failed") {
          this.repositories.chatSessions.fail(conversationId, request.requestId);
          safeEmit(event);
          settled = true;
          return;
        }
        safeEmit(event);
      }
      fail("worker_stream_ended_without_terminal");
    } catch {
      fail("worker_stream_failed");
    } finally {
      this.options.onConsumptionFinished?.(request.requestId);
    }
  }

  private async generateTitle(conversationId: ConversationId, content: string): Promise<void> {
    const generatedTitle = await this.options.titleGenerator?.generateConversationTitle(content);
    if (generatedTitle === undefined || generatedTitle.trim().length === 0) return;
    // A late completion must not recreate a Conversation deleted while the model was running.
    if (this.repositories.conversations.getById(conversationId) === undefined) return;
    const updated = this.repositories.conversations.updateTitle(conversationId, generatedTitle);
    for (const listener of [...this.conversationUpdateListeners]) {
      try { listener(updated); } catch { /* A metadata sink must not break persistence. */ }
    }
  }
}
