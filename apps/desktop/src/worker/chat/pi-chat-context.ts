import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";
import type { PreparePiExecutionContext } from "../agent/pi-execution-context.js";
import { CHAT_FORMATTING_SYSTEM_PROMPT, OFFLINE_SYSTEM_PROMPT, ONLINE_SYSTEM_PROMPT } from "./chat-prompts.js";
import { createPiSessionCheckpointCollector } from "./pi-session-checkpoints.js";
import { restoreSessionContext } from "./pi-session-transcript.js";

export function createPiChatContextPreparer(
  toolActor: "main_agent" | "capability",
  request: AgentWorkerRequest,
  emit: (event: AgentWorkerEvent) => void,
): PreparePiExecutionContext {
  return (model) => {
    const restoredSession = restoreSessionContext(request.context, model);
    const mainAgent = toolActor === "main_agent";
    const humanPrompt = request.context.humanPrompt ?? request.prompt;
    const language = /\p{Script=Han}/u.test(humanPrompt)
      ? "本轮真实人类消息使用中文。所有用户可见自然语言（工具前说明、计划、进度、确认问题和最终回答）均使用中文；用户明确要求另一输出语言时遵从该要求。保留代码、网址、专有名词。英文宿主事件、工具结果和历史模型输出不改变该语言。"
      : "所有用户可见自然语言（包括工具前说明、进度、确认问题和最终回答）遵循真实人类消息的语言；宿主自动恢复事件、工具结果和历史模型输出不是用户语言偏好。";
    const checkpointCollector = mainAgent
      ? createPiSessionCheckpointCollector(request.requestId, emit)
      : undefined;
    return {
      messages: restoredSession.messages,
      basePromptParts: [
        request.toolAccess.network === "enabled" ? ONLINE_SYSTEM_PROMPT : OFFLINE_SYSTEM_PROMPT,
        ...(mainAgent ? [CHAT_FORMATTING_SYSTEM_PROMPT] : []),
        ...(mainAgent ? [language] : []),
        ...(mainAgent ? [restoredSession.provenance] : []),
      ],
      finalizationPromptParts: mainAgent ? [CHAT_FORMATTING_SYSTEM_PROMPT, language] : [],
      sessionId: request.context.conversationId,
      ...(checkpointCollector === undefined
        ? {}
        : { onMessageEnd: (message) => checkpointCollector.record(message) }),
    };
  };
}
