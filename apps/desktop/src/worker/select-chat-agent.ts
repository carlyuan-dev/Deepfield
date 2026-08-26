import type { ChatAgent } from "./message-loop.js";

export interface ChatAgentFactories {
  fake: () => ChatAgent;
  pi: () => ChatAgent;
}

export function selectChatAgent(
  mode: string | undefined,
  factories: ChatAgentFactories,
): ChatAgent {
  return mode === "fake" ? factories.fake() : factories.pi();
}
