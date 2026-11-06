import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, Tool } from "@earendil-works/pi-ai";

export interface PreparedPiExecutionContext {
  messages: Message[];
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal, framing?: { systemPrompt: string; tools: Tool[] }) => Promise<AgentMessage[]>;
  basePromptParts: string[];
  finalizationPromptParts: string[];
  sessionId: string;
  onMessageEnd?: (message: AgentMessage) => void;
}

export type PreparePiExecutionContext = (
  model: Model<Api>,
) => PreparedPiExecutionContext;
