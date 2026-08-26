import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  DEFAULT_DEEPSEEK_MODEL_ID,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
  type ChatMessage,
  type ConversationId,
  type ProjectId,
} from "@deepfield/contracts";
import type { Repositories } from "@deepfield/persistence";
import type { ContextBuilder } from "./context-builder.js";
import type { AgentWorkerPort, RequestIdFactory, SecretReader } from "./ports.js";

export const DEEPSEEK_KEY_NAME = "deepseek.apiKey";

export class ChatServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatServiceError";
  }
}

export interface ChatSendResult {
  requestId: string;
}

export interface ChatServiceOptions {
  requestIdFactory?: RequestIdFactory;
  onConsumptionFinished?: (requestId: string) => void;
}

const FAILED_MESSAGE = "chat request failed";

export class ChatService {
  constructor(
    private readonly repositories: Repositories,
    private readonly contextBuilder: ContextBuilder,
    private readonly secrets: SecretReader,
    private readonly worker: AgentWorkerPort,
    private readonly options: ChatServiceOptions = {},
  ) {}

  async send(
    projectId: string,
    content: string,
    onEvent: (event: AgentWorkerEvent) => void,
  ): Promise<ChatSendResult> {
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new ChatServiceError("content must not be blank");
    }
    const apiKey = this.secrets.get(DEEPSEEK_KEY_NAME);
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new ChatServiceError("deepseek api key is not configured");
    }
    const project = this.repositories.projects.getById(projectId as ProjectId);
    if (!project) {
      throw new ChatServiceError("project not found");
    }
    const conversation = this.repositories.conversations.listByProject(projectId as ProjectId)[0];
    if (!conversation) {
      throw new ChatServiceError("conversation not found");
    }

    let userMessage: ChatMessage;
    try {
      userMessage = this.repositories.runInTransaction(() => {
        const message = this.repositories.messages.append(conversation.id, "user", content);
        this.repositories.conversations.markHasUserMessage(conversation.id);
        return message;
      });
    } catch {
      throw new ChatServiceError("failed to persist user message");
    }
    const context = this.contextBuilder.build(project.id, { excludeMessageId: userMessage.id });

    const requestId = this.options.requestIdFactory?.() ?? randomUUID();
    const request: AgentWorkerRequest = {
      requestId,
      kind: "chat.prompt",
      prompt: content,
      context,
      apiKey,
      modelId: DEFAULT_DEEPSEEK_MODEL_ID,
    };

    void this.consume(request, conversation.id, project.id, onEvent).catch(() => {
      // Background consumption must never surface as an unhandled rejection.
    });
    return { requestId };
  }

  private async consume(
    request: AgentWorkerRequest,
    conversationId: ConversationId,
    projectId: ProjectId,
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
            this.repositories.runInTransaction(() => {
              this.repositories.messages.append(conversationId, "assistant", event.text);
              this.repositories.activities.append(
                projectId,
                "chat.message.completed",
                "chat",
                "normal",
                "Chat 回复完成",
                { requestId: request.requestId, conversationId },
              );
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
