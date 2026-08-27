import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentOptions, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_DEEPSEEK_MODEL_ID,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from "@deepfield/contracts";
import type { ChatAgent } from "./message-loop.js";
import { mapHistoryMessages } from "./pi-message-mapper.js";

export class PiChatAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiChatAgentError";
  }
}

export interface PiSession {
  model: Model<Api>;
  streamFn: StreamFn;
}

export interface PiAgentHandle {
  subscribe(
    listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void,
  ): () => void;
  abort(): void;
  prompt(message: string): Promise<void>;
}

export interface PiRuntime {
  createSession(): PiSession | undefined;
  createAgent(options: AgentOptions): PiAgentHandle;
}

export function defaultPiRuntime(): PiRuntime {
  return {
    createSession() {
      const models = createModels();
      models.setProvider(deepseekProvider());
      const model = models.getModel("deepseek", DEFAULT_DEEPSEEK_MODEL_ID);
      if (!model) {
        return undefined;
      }
      return { model, streamFn: models.streamSimple.bind(models) };
    },
    createAgent(options) {
      return new Agent(options);
    },
  };
}

function hasProviderFailure(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "assistant"
    ) {
      const assistant = message as AssistantMessage;
      return (
        assistant.stopReason === "error" ||
        assistant.stopReason === "aborted" ||
        assistant.errorMessage !== undefined
      );
    }
  }
  return false;
}

export function createPiChatAgent(
  runtime: PiRuntime = defaultPiRuntime(),
  tools: AgentTool<any>[] = [],
): ChatAgent {
  return {
    async run(
      request: AgentWorkerRequest,
      emit: (event: AgentWorkerEvent) => void,
      signal: AbortSignal,
    ): Promise<void> {
      const session = runtime.createSession();
      if (!session) {
        throw new PiChatAgentError("deepseek model is not available");
      }

      let finalText = "";
      let startedEmitted = false;
      let sawAgentEnd = false;
      let providerFailure = false;
      let adapterSettled = false;

      const emitTerminal = (event: AgentWorkerEvent): void => {
        if (adapterSettled) {
          return;
        }
        adapterSettled = true;
        emit(event);
      };

      const agent = runtime.createAgent({
        initialState: {
          systemPrompt: request.context.systemPrompt,
          model: session.model,
          messages: mapHistoryMessages(request.context.messages, session.model),
          tools,
          thinkingLevel: "off",
        },
        streamFn: session.streamFn,
        getApiKey: (provider) => (provider === "deepseek" ? request.apiKey : undefined),
        sessionId: request.context.conversationId,
        toolExecution: "sequential",
      });

      const abort = (): void => agent.abort();
      if (signal.aborted) {
        // Pi's abort() is a no-op before an active run exists; never start a
        // prompt that is already meant to be cancelled.
        abort();
        throw new PiChatAgentError("agent execution aborted before start");
      }
      signal.addEventListener("abort", abort, { once: true });

      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "agent_start") {
          if (!startedEmitted) {
            startedEmitted = true;
            emit({ requestId: request.requestId, type: "started" });
          }
          return;
        }
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          finalText += event.assistantMessageEvent.delta;
          emit({
            requestId: request.requestId,
            type: "text_delta",
            delta: event.assistantMessageEvent.delta,
          });
          return;
        }
        if (event.type === "agent_end") {
          sawAgentEnd = true;
          if (hasProviderFailure(event.messages)) {
            providerFailure = true;
          }
        }
      });

      try {
        await agent.prompt(request.prompt);
      } catch {
        throw new PiChatAgentError("agent execution failed");
      } finally {
        signal.removeEventListener("abort", abort);
        unsubscribe();
      }

      if (providerFailure) {
        throw new PiChatAgentError("agent execution failed");
      }
      if (!startedEmitted || !sawAgentEnd) {
        throw new PiChatAgentError("agent finished without a complete start/end sequence");
      }
      emitTerminal({ requestId: request.requestId, type: "completed", text: finalText });
    },
  };
}
