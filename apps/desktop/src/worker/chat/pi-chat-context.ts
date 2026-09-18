import type { PreparePiExecutionContext } from "../agent/pi-execution-context.js";
import { CHAT_FORMATTING_SYSTEM_PROMPT, OFFLINE_SYSTEM_PROMPT, ONLINE_SYSTEM_PROMPT } from "./chat-prompts.js";
import { createPiSessionCheckpointCollector } from "./pi-session-checkpoints.js";
import { restoreSessionContext } from "./pi-session-transcript.js";

export function createPiChatContextPreparer(
  toolActor: "main_agent" | "capability",
): PreparePiExecutionContext {
  return (request, model, emit) => {
    const restoredSession = restoreSessionContext(request.context, model);
    const mainAgent = toolActor === "main_agent";
    const checkpointCollector = mainAgent
      ? createPiSessionCheckpointCollector(request.requestId, emit)
      : undefined;
    return {
      messages: restoredSession.messages,
      basePromptParts: [
        request.toolAccess.network === "enabled" ? ONLINE_SYSTEM_PROMPT : OFFLINE_SYSTEM_PROMPT,
        ...(mainAgent ? [CHAT_FORMATTING_SYSTEM_PROMPT] : []),
        ...(mainAgent ? [restoredSession.provenance] : []),
      ],
      finalizationPromptParts: mainAgent ? [CHAT_FORMATTING_SYSTEM_PROMPT] : [],
      sessionId: request.context.conversationId,
      ...(checkpointCollector === undefined
        ? {}
        : { onMessageEnd: (message) => checkpointCollector.record(message) }),
    };
  };
}
