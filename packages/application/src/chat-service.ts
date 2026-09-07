import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  DEFAULT_DEEPSEEK_MODEL_ID,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
  type ChatMessage,
  type ChatRequestOptions,
  type ChatSendResult,
  type Conversation,
  type ConversationId,
} from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import type { ContextBuilder } from "./context-builder.js";
import type { AgentWorkerPort, SecretReader } from "./ports.js";

export const DEEPSEEK_KEY_NAME = "deepseek.apiKey";

export type { ChatSendResult } from "@deepfield/contracts";

export class ChatServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatServiceError";
  }
}

export interface ChatServiceOptions {
  onConsumptionFinished?: (requestId: string) => void;
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
  constructor(
    private readonly repositories: Repositories,
    private readonly contextBuilder: ContextBuilder,
    private readonly secrets: SecretReader,
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
    const apiKey = this.secrets.get(DEEPSEEK_KEY_NAME);
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new ChatServiceError("deepseek api key is not configured");
    }
    const conversation = this.repositories.conversations.getById(conversationId as ConversationId);
    if (!conversation) {
      throw new ChatServiceError("conversation not found");
    }

    let userMessage: ChatMessage;
    let updated: Conversation = conversation;
    try {
      userMessage = this.repositories.runInTransaction(() => {
        const message = this.repositories.messages.append(conversation.id, "user", content);
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
      apiKey,
      modelId: DEFAULT_DEEPSEEK_MODEL_ID,
    };

    void this.consume(request, conversation.id, onEvent).catch(() => {
      // Background consumption must never surface as an unhandled rejection.
    });
    return { requestId, conversation: updated };
  }

  listMessages(conversationId: string): ChatMessage[] {
    const conversation = this.repositories.conversations.getById(conversationId as ConversationId);
    if (!conversation) {
      throw new ChatServiceError("conversation not found");
    }
    return this.repositories.messages.listByConversation(conversation.id);
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
        if (event.type === "completed") {
          try {
            // Standalone Chat has no Project: persist the assistant reply only,
            // without writing a Project activity event.
            this.repositories.runInTransaction(() => {
              this.repositories.messages.append(conversationId, "assistant", event.text);
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
}
