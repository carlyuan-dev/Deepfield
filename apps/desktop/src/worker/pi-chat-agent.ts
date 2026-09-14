import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentOptions, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  type LlmRuntimeSnapshot,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from "@deepfield/contracts";
import type { ChatAgent } from "./message-loop.js";
import { mapHistoryMessages } from "./pi-message-mapper.js";
import {
  buildRuntimeSystemContext,
  type RuntimeSystemContextOptions,
} from "./runtime-system-context.js";
import type { PiSkillCatalog } from "../shared/pi-skill-catalog.js";
import { safeToolActivity, type SafeToolActivity } from "./tool-activity.js";
import { PiModelGateway, type ModelGateway } from "../shared/model-gateway.js";
import { createSearchProvider, type SearchProvider } from "@deepfield/retrieval";

const OFFLINE_SYSTEM_PROMPT = [
  "本轮未启用联网搜索，不能访问用户提供的网页，也不能获取最新或实时信息。",
  "如需网页内容或最新信息，提示用户打开输入区的“联网搜索”后重新发送。",
  "不要据此声称本地文件不可处理；本地附件能力不属于本轮联网状态说明。",
].join("\n");
const ONLINE_SYSTEM_PROMPT = [
  "本轮已开放联网工具 web_search 与 read_webpage。",
  "遇到最新信息或需要核实网页事实时，应使用这些工具，不得声称没有联网能力。",
  "使用与用户相同的语言回答；用户使用中文时，最终回答必须使用中文。",
  "调用工具前后的计划、进度和重试说明属于内部执行过程，不要把它们当作最终回答。",
  "完成工具调用后必须基于已获得的信息给出可独立阅读的最终回答。",
].join("\n");
const SYNTHESIS_SYSTEM_PROMPT = [
  "工具阶段已结束，本轮不能再调用任何工具。",
  "请立即基于已有工具结果回答用户；即使部分工具失败，也要用用户的语言给出当前证据允许的最佳答案，并清楚说明无法确认的部分。",
  "只输出最终回答，不输出搜索计划、重试过程或工具协议。",
].join("\n");

export class PiChatAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiChatAgentError";
  }
}

export interface SkillCatalogProvider {
  get(): Promise<PiSkillCatalog>;
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
  createSession(snapshot: LlmRuntimeSnapshot): PiSession | undefined;
  createAgent(options: AgentOptions): PiAgentHandle;
}

export interface PiToolSessionProvider {
  createAgentTools(context: {
    traceId: string;
    actor: "main_agent" | "capability";
    networkEnabled?: boolean;
  }): AgentTool<any>[];
  bindSearchProvider(traceId: string, provider: SearchProvider, limits?: { maxCalls?: number; categoryCalls?: { search?: number; fetch?: number } }): void;
  releaseTrace(traceId: string): boolean;
}

export function defaultPiRuntime(gateway: ModelGateway = new PiModelGateway()): PiRuntime {
  return {
    createSession(snapshot) {
      return { model: gateway.createModel(snapshot), streamFn: streamSimple };
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

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function assistantTurnCount(messages: unknown[]): number {
  return messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { role?: unknown }).role === "assistant",
  ).length;
}

function hasToolCalls(message: AssistantMessage): boolean {
  return message.content.some((part) => part.type === "toolCall");
}

function finalToolFreeAnswer(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      (candidate as { role?: unknown }).role !== "assistant"
    ) {
      continue;
    }
    const assistant = candidate as AssistantMessage;
    if (hasToolCalls(assistant)) {
      return undefined;
    }
    return assistantText(assistant);
  }
  return undefined;
}

function isAcceptableFinalAnswer(text: string | undefined, userPrompt: string): text is string {
  if (text === undefined || text.trim().length === 0) return false;
  if (text.includes("<｜｜DSML｜｜") || text.includes("<|DSML|>")) return false;
  const containsHan = /\p{Script=Han}/u;
  return !containsHan.test(userPrompt) || containsHan.test(text);
}

export function createPiChatAgent(
  runtime: PiRuntime = defaultPiRuntime(),
  tools: AgentTool<any>[] = [],
  skills?: SkillCatalogProvider,
  runtimeContext: RuntimeSystemContextOptions = {},
  toolSessions?: PiToolSessionProvider,
  gateway: ModelGateway = new PiModelGateway(),
  searchProviderFactory: (snapshot: NonNullable<AgentWorkerRequest["search"]>) => SearchProvider = createSearchProvider,
  toolActor: "main_agent" | "capability" = "main_agent",
): ChatAgent {
  return {
    async run(
      request: AgentWorkerRequest,
      emit: (event: AgentWorkerEvent) => void,
      signal: AbortSignal,
    ): Promise<void> {
      const session = runtime.createSession(request.llm);
      if (!session) {
        throw new PiChatAgentError("configured model is not available");
      }

      const skillName = request.options.skillName;
      let prompt: string;
      if (skillName === undefined) {
        prompt = request.prompt;
      } else {
        if (!skills) {
          throw new PiChatAgentError("agent execution failed");
        }
        try {
          prompt = (await skills.get()).formatInvocation(skillName, request.prompt);
        } catch {
          // Unknown skills and catalog load failures map to the same fixed,
          // non-sensitive chat failure as any other agent execution error.
          throw new PiChatAgentError("agent execution failed");
        }
      }

      try {
        if (request.toolAccess.network === "enabled") {
          if (request.search === undefined || toolSessions === undefined) throw new PiChatAgentError("search is not configured");
          toolSessions.bindSearchProvider(request.requestId, searchProviderFactory(request.search), {
            maxCalls: request.toolAccess.maxSearchCalls + request.toolAccess.maxFetchCalls + 8,
            categoryCalls: { search: request.toolAccess.maxSearchCalls, fetch: request.toolAccess.maxFetchCalls },
          });
        }
        const requestTools =
          toolSessions === undefined
            ? tools
            : [
                ...tools,
                ...toolSessions.createAgentTools({
                  traceId: request.requestId,
                  actor: toolActor,
                  networkEnabled: request.toolAccess.network === "enabled",
                }),
              ];
        let finalText: string | undefined;
        let startedEmitted = false;
        let sawAgentEnd = false;
        let providerFailure = false;
        let adapterSettled = false;
        let activitySequence = 0;
        const activeActivities = new Map<
          string,
          SafeToolActivity & { callKey: string }
        >();

        const emitActivity = (
          activity: SafeToolActivity & { callKey: string },
          status: "running" | "completed" | "failed",
        ): void => {
          emit({
            requestId: request.requestId,
            type: "tool_activity",
            callKey: activity.callKey,
            name: activity.name,
            status,
            ...(activity.summary === undefined ? {} : { summary: activity.summary }),
          });
        };

        const failActiveActivities = (): void => {
          for (const activity of activeActivities.values()) {
            emitActivity(activity, "failed");
          }
          activeActivities.clear();
        };

        const emitTerminal = (event: AgentWorkerEvent): void => {
          if (adapterSettled) {
            return;
          }
          adapterSettled = true;
          emit(event);
        };

        const agent = runtime.createAgent({
          initialState: {
            systemPrompt: [
              request.context.systemPrompt,
              buildRuntimeSystemContext(runtimeContext),
              request.toolAccess.network === "enabled" ? ONLINE_SYSTEM_PROMPT : OFFLINE_SYSTEM_PROMPT,
            ].join("\n"),
            model: session.model,
            messages: mapHistoryMessages(request.context.messages, session.model),
            tools: requestTools,
            thinkingLevel: "off",
          },
          streamFn: session.streamFn,
          getApiKey: (provider) => gateway.getApiKey(request.llm, provider),
          sessionId: request.context.conversationId,
          toolExecution: "sequential",
          prepareNextTurnWithContext: ({ message, context, newMessages }) => {
            if (
              assistantTurnCount(newMessages) < request.toolAccess.maxAgentTurns - 1 ||
              !hasToolCalls(message)
            ) {
              return undefined;
            }
            return {
              context: {
                ...context,
                systemPrompt: `${context.systemPrompt}\n${SYNTHESIS_SYSTEM_PROMPT}`,
                tools: [],
              },
            };
          },
          shouldStopAfterTurn: ({ newMessages }) => newMessages.filter((message) => message.role === "assistant").length >= request.toolAccess.maxAgentTurns,
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
              emit({
                requestId: request.requestId,
                type: "started",
                ...(skillName !== undefined ? { skillName } : {}),
                ...(request.toolAccess.network === "enabled" ? { webSearch: true } : {}),
              });
            }
            return;
          }
          // Assistant text that precedes a tool call is internal execution
          // narration. Wait for agent_end so only the last tool-free turn can
          // become user-visible answer text.
          if (event.type === "message_update") return;
          if (event.type === "tool_execution_start") {
            if (activeActivities.has(event.toolCallId)) return;
            activitySequence += 1;
            const activity = {
              callKey: `activity-${activitySequence}`,
              ...safeToolActivity(event.toolName, event.args),
            };
            activeActivities.set(event.toolCallId, activity);
            emitActivity(activity, "running");
            return;
          }
          if (event.type === "tool_execution_end") {
            const activity = activeActivities.get(event.toolCallId);
            if (activity === undefined) return;
            emitActivity(activity, event.isError ? "failed" : "completed");
            activeActivities.delete(event.toolCallId);
            return;
          }
          if (event.type === "agent_end") {
            sawAgentEnd = true;
            if (hasProviderFailure(event.messages)) {
              providerFailure = true;
            }
            finalText = finalToolFreeAnswer(event.messages);
          }
        });

        try {
          await agent.prompt(prompt);
        } catch {
          failActiveActivities();
          throw new PiChatAgentError("agent execution failed");
        } finally {
          signal.removeEventListener("abort", abort);
          unsubscribe();
        }

        if (providerFailure) {
          failActiveActivities();
          throw new PiChatAgentError("agent execution failed");
        }
        if (!startedEmitted || !sawAgentEnd) {
          failActiveActivities();
          throw new PiChatAgentError("agent finished without a complete start/end sequence");
        }
        if (!isAcceptableFinalAnswer(finalText, request.prompt)) {
          failActiveActivities();
          throw new PiChatAgentError("agent finished without a final answer");
        }
        failActiveActivities();
        emit({ requestId: request.requestId, type: "text_delta", delta: finalText });
        emitTerminal({ requestId: request.requestId, type: "completed", text: finalText });
      } finally {
        toolSessions?.releaseTrace(request.requestId);
      }
    },
  };
}
