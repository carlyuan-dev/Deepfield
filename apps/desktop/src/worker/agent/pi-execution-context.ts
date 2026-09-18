import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";

export interface PreparedPiExecutionContext {
  messages: Message[];
  basePromptParts: string[];
  finalizationPromptParts: string[];
  sessionId: string;
  onMessageEnd?: (message: AgentMessage) => void;
}

export type PreparePiExecutionContext = (
  model: Model<Api>,
) => PreparedPiExecutionContext;
