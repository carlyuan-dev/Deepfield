import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";

/**
 * Worker-internal execution boundary. It still uses Worker request/event
 * contracts and is not an application-neutral Base Agent contract.
 */
export interface PreparedPiExecutionContext {
  messages: Message[];
  basePromptParts: string[];
  finalizationPromptParts: string[];
  sessionId: string;
  onMessageEnd?: (message: AgentMessage) => void;
}

export type PreparePiExecutionContext = (
  request: AgentWorkerRequest,
  model: Model<Api>,
  emit: (event: AgentWorkerEvent) => void,
) => PreparedPiExecutionContext;
