import type { AgentContextMessage } from "@deepfield/contracts";
import type {
  Api,
  AssistantMessage,
  Message,
  ProviderId,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";

export interface ModelIdentity {
  id: string;
  api: Api;
  provider: ProviderId;
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function mapHistoryMessages(
  messages: AgentContextMessage[],
  model: ModelIdentity,
): Message[] {
  return messages.map((message): Message => {
    if (message.role === "user") {
      const userMessage: UserMessage = {
        role: "user",
        content: message.content,
        timestamp: message.timestamp,
      };
      return userMessage;
    }
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: message.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: message.timestamp,
    };
    return assistantMessage;
  });
}
