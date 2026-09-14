import { Agent } from "@earendil-works/pi-agent-core";
import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  type LlmRuntimeSnapshot,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
  type ToolExecutionBatchScope,
  type ToolSyntheticAuditRecord,
} from "@deepfield/contracts";
import type { ToolBudgetSnapshot } from "@deepfield/tool-platform";
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
import { createAgentRunControl, WEB_CHAT_POLICY } from "./agent-run-control.js";
import {
  buildRuntimeBudgetContext,
  type RuntimeBatchSummary,
} from "./runtime-budget-context.js";
import {
  planToolBatch,
  type PlannedToolCall,
  type PriorToolResult,
  type ToolBatchPlan,
} from "./tool-batch-admission.js";

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
const SYNTHESIS_USER_PROMPT =
  "请基于本轮已经获得的工具结果重新组织并输出最终答案。不要再描述搜索计划、调用过程或重试过程。";

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
  followUp(message: AgentMessage): void;
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
    batchScopeFor?: (toolCallId: string) => ToolExecutionBatchScope | undefined;
  }): AgentTool<any>[];
  bindSearchProvider(traceId: string, provider: SearchProvider, limits?: { maxCalls?: number; categoryCalls?: { search?: number; fetch?: number } }): void;
  budgetSnapshot(traceId: string): ToolBudgetSnapshot;
  recordSynthetic(record: ToolSyntheticAuditRecord): Promise<void>;
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

interface CachedPiToolOutcome {
  status: "completed" | "failed";
  result?: AgentToolResult<unknown>;
  error?: unknown;
  errorCode?: string;
  retryable?: boolean;
}

function parseToolFailure(error: unknown): { code?: string; retryable?: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  const jsonStart = message.indexOf("{");
  if (jsonStart < 0) return {};
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as { code?: unknown; retryable?: unknown };
    return {
      ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
      ...(typeof parsed.retryable === "boolean" ? { retryable: parsed.retryable } : {}),
    };
  } catch {
    return {};
  }
}

function toolResultFailureCode(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    const match = text.match(/"code":"([a-z_]+)"/);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

const NETWORK_TOOL_NAMES = new Set(["web_search", "read_webpage"]);

function filterRuntimeTools(
  tools: AgentTool<any>[],
  availableNetworkTools: readonly string[],
): AgentTool<any>[] {
  const available = new Set(availableNetworkTools);
  return tools.filter((tool) => !NETWORK_TOOL_NAMES.has(tool.name) || available.has(tool.name));
}

function assistantToolCalls(message: AssistantMessage): Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
}> {
  return message.content.flatMap((part) => {
    if (part.type !== "toolCall") return [];
    const input =
      typeof part.arguments === "object" && part.arguments !== null
        ? (part.arguments as Record<string, unknown>)
        : {};
    return [{ id: part.id, name: part.name, input }];
  });
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
        const online = request.toolAccess.network === "enabled";
        const batchScopeByCallId = new Map<string, ToolExecutionBatchScope>();
        const priorResults = new Map<string, PriorToolResult>();
        const plans = new WeakMap<AssistantMessage, ToolBatchPlan>();
        const decisionsByCallId = new Map<string, PlannedToolCall>();
        const outcomesByCallId = new Map<string, CachedPiToolOutcome>();
        const syntheticRecorded = new Set<string>();
        const runPolicy = {
          ...WEB_CHAT_POLICY,
          toolDecisionTurns: Math.max(0, request.toolAccess.maxAgentTurns - 1),
          budgets: {
            webSearch: request.toolAccess.maxSearchCalls,
            readWebpage: request.toolAccess.maxFetchCalls,
          },
        };
        const control = createAgentRunControl(runPolicy, Number.POSITIVE_INFINITY);
        if (request.toolAccess.network === "enabled") {
          if (request.search === undefined || toolSessions === undefined) throw new PiChatAgentError("search is not configured");
          toolSessions.bindSearchProvider(request.requestId, searchProviderFactory(request.search), {
            maxCalls: request.toolAccess.maxSearchCalls + request.toolAccess.maxFetchCalls + 8,
            categoryCalls: { search: request.toolAccess.maxSearchCalls, fetch: request.toolAccess.maxFetchCalls },
          });
          control.observeSnapshot(toolSessions.budgetSnapshot(request.requestId));
        }
        const rawRequestTools =
          toolSessions === undefined
            ? tools
            : [
                ...tools,
                ...toolSessions.createAgentTools({
                  traceId: request.requestId,
                  actor: toolActor,
                  networkEnabled: request.toolAccess.network === "enabled",
                  batchScopeFor: (toolCallId) => batchScopeByCallId.get(toolCallId),
                }),
              ];
        const recordReused = async (
          decision: PlannedToolCall,
          outcome: CachedPiToolOutcome,
        ): Promise<void> => {
          if (toolSessions === undefined || syntheticRecorded.has(decision.id)) return;
          const scope = batchScopeByCallId.get(decision.id);
          if (scope === undefined) return;
          syntheticRecorded.add(decision.id);
          await toolSessions.recordSynthetic({
            executionId: `synthetic:${request.requestId}:${scope.batchId}:${decision.id}`,
            traceId: request.requestId,
            actor: toolActor,
            tool: { name: decision.name, version: 1 },
            status: "reused",
            ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
            ...scope,
            attempts: 0,
            budgetConsumed: false,
          });
        };
        const requestTools = rawRequestTools.map((tool) => {
          if (!NETWORK_TOOL_NAMES.has(tool.name)) return tool;
          return {
            ...tool,
            async execute(toolCallId, params, executeSignal, onUpdate) {
              const decision = decisionsByCallId.get(toolCallId);
              if (decision?.disposition === "reused") {
                const cached =
                  (decision.priorResult?.result as CachedPiToolOutcome | undefined) ??
                  (decision.reusedFromId === undefined
                    ? undefined
                    : outcomesByCallId.get(decision.reusedFromId));
                if (cached === undefined) {
                  throw new Error("tool_failed {\"code\":\"tool_error\",\"message\":\"cached tool result unavailable\",\"retryable\":false,\"attempts\":0}");
                }
                await recordReused(decision, cached);
                if (cached.status === "completed" && cached.result !== undefined) {
                  return cached.result;
                }
                throw cached.error;
              }
              try {
                const result = await tool.execute(toolCallId, params, executeSignal, onUpdate);
                const outcome: CachedPiToolOutcome = { status: "completed", result };
                outcomesByCallId.set(toolCallId, outcome);
                if (decision?.normalizedKey !== undefined) {
                  priorResults.set(decision.normalizedKey, {
                    status: "completed",
                    result: outcome,
                  });
                }
                return result;
              } catch (error) {
                const failure = parseToolFailure(error);
                if (
                  failure.code === "authentication_failed" &&
                  (tool.name === "web_search" || tool.name === "read_webpage")
                ) {
                  control.disableNetworkTool(tool.name);
                }
                const outcome: CachedPiToolOutcome = {
                  status: "failed",
                  error,
                  ...(failure.code === undefined ? {} : { errorCode: failure.code }),
                  ...(failure.retryable === undefined ? {} : { retryable: failure.retryable }),
                };
                outcomesByCallId.set(toolCallId, outcome);
                if (decision?.normalizedKey !== undefined) {
                  priorResults.set(decision.normalizedKey, {
                    status: "failed",
                    ...(failure.retryable === undefined
                      ? {}
                      : { retryable: failure.retryable }),
                    result: outcome,
                  });
                }
                throw error;
              }
            },
          } satisfies AgentTool<any>;
        });
        let latestBatchSummary: RuntimeBatchSummary | undefined;
        const baseSystemPrompt = [
          request.context.systemPrompt,
          buildRuntimeSystemContext(runtimeContext),
          online ? ONLINE_SYSTEM_PROMPT : OFFLINE_SYSTEM_PROMPT,
        ].join("\n");
        const composeSystemPrompt = (): string =>
          online
            ? `${baseSystemPrompt}\n${buildRuntimeBudgetContext(control, latestBatchSummary)}`
            : baseSystemPrompt;
        let finalText: string | undefined;
        let startedEmitted = false;
        let sawAgentEnd = false;
        let providerFailure = false;
        let adapterSettled = false;
        let streamAnswer = !online || control.phase() === "synthesizing";
        let streamedAnswer = "";
        let synthesisFollowUpPending = false;
        let synthesisFollowUpSent = false;
        let activitySequence = 0;
        const activeActivities = new Map<
          string,
          SafeToolActivity & { callKey: string }
        >();

        const emitActivity = (
          activity: SafeToolActivity & { callKey: string },
          status: "running" | "completed" | "failed" | "skipped" | "reused",
          metadata?: {
            errorCode?: string;
            agentTurnIndex?: number;
            batchId?: string;
            toolCallId?: string;
            budgetConsumed?: boolean;
          },
        ): void => {
          emit({
            requestId: request.requestId,
            type: "tool_activity",
            callKey: activity.callKey,
            name: activity.name,
            status,
            ...(activity.summary === undefined ? {} : { summary: activity.summary }),
            ...(metadata?.errorCode === undefined ? {} : { errorCode: metadata.errorCode }),
            ...(metadata?.agentTurnIndex === undefined
              ? {}
              : { agentTurnIndex: metadata.agentTurnIndex }),
            ...(metadata?.batchId === undefined ? {} : { batchId: metadata.batchId }),
            ...(metadata?.toolCallId === undefined
              ? {}
              : { toolCallId: metadata.toolCallId }),
            ...(metadata?.budgetConsumed === undefined
              ? {}
              : { budgetConsumed: metadata.budgetConsumed }),
          } as AgentWorkerEvent);
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

        let agent!: PiAgentHandle;
        agent = runtime.createAgent({
          initialState: {
            systemPrompt: composeSystemPrompt(),
            model: session.model,
            messages: mapHistoryMessages(request.context.messages, session.model),
            tools: online
              ? control.phase() === "synthesizing"
                ? []
                : filterRuntimeTools(requestTools, control.availableNetworkTools())
              : requestTools,
            thinkingLevel: "off",
          },
          streamFn: session.streamFn,
          getApiKey: (provider) => gateway.getApiKey(request.llm, provider),
          sessionId: request.context.conversationId,
          toolExecution: "sequential",
          beforeToolCall: async ({ assistantMessage, toolCall }) => {
            if (!online || toolSessions === undefined || !NETWORK_TOOL_NAMES.has(toolCall.name)) {
              return undefined;
            }
            let plan = plans.get(assistantMessage);
            if (plan === undefined) {
              const snapshot = toolSessions.budgetSnapshot(request.requestId);
              control.observeSnapshot(snapshot);
              const turnIndex = control.turns().toolDecisionUsed + 1;
              plan = planToolBatch({
                calls: assistantToolCalls(assistantMessage),
                snapshot,
                priorResults,
                turnIndex,
              });
              plans.set(assistantMessage, plan);
              for (const decision of [...plan.admitted, ...plan.skipped, ...plan.reused]) {
                decisionsByCallId.set(decision.id, decision);
                batchScopeByCallId.set(decision.id, {
                  agentTurnIndex: plan.turnIndex,
                  batchId: plan.batchId,
                  toolCallId: decision.id,
                });
              }
              control.recordToolDecisionTurn();
              control.beginExecution();
            }
            let decision = decisionsByCallId.get(toolCall.id);
            if (
              decision !== undefined &&
              decision.disposition !== "skipped" &&
              (toolCall.name === "web_search" || toolCall.name === "read_webpage") &&
              !control.networkToolEnabled(toolCall.name)
            ) {
              decision = { ...decision, disposition: "skipped" };
              decisionsByCallId.set(toolCall.id, decision);
            }
            if (decision?.disposition !== "skipped") return undefined;
            if (!syntheticRecorded.has(toolCall.id)) {
              syntheticRecorded.add(toolCall.id);
              await toolSessions.recordSynthetic({
                executionId: `synthetic:${request.requestId}:${plan.batchId}:${toolCall.id}`,
                traceId: request.requestId,
                actor: toolActor,
                tool: { name: toolCall.name, version: 1 },
                status: "skipped",
                errorCode: "budget_trimmed",
                agentTurnIndex: plan.turnIndex,
                batchId: plan.batchId,
                toolCallId: toolCall.id,
                attempts: 0,
                budgetConsumed: false,
              });
            }
            return {
              block: true,
              reason: JSON.stringify({
                status: "skipped",
                code: "budget_trimmed",
                message: "该调用超出本轮剩余额度，未向服务商发送请求",
                budgetConsumed: false,
              }),
            };
          },
          prepareNextTurnWithContext: ({ message, toolResults, context, newMessages }) => {
            const mustReserveLastTurn =
              hasToolCalls(message) &&
              assistantTurnCount(newMessages) >= request.toolAccess.maxAgentTurns - 1;
            const toolPhaseFinished = online && !streamAnswer && !hasToolCalls(message);
            if (online && hasToolCalls(message)) {
              const plan = plans.get(message);
              const admittedCallIds = new Set(plan?.admitted.map((call) => call.id) ?? []);
              for (const result of toolResults) {
                const code = toolResultFailureCode(result);
                const toolName = (result as { toolName?: unknown }).toolName;
                if (
                  code === "authentication_failed" &&
                  (toolName === "web_search" || toolName === "read_webpage")
                ) {
                  control.disableNetworkTool(toolName);
                }
              }
              const successfulSearches = toolResults.filter(
                (result) =>
                  admittedCallIds.has(String((result as { toolCallId?: unknown }).toolCallId)) &&
                  (result as { toolName?: unknown }).toolName === "web_search" &&
                  (result as { isError?: unknown }).isError !== true,
              ).length;
              const successfulFetches = toolResults.filter(
                (result) =>
                  admittedCallIds.has(String((result as { toolCallId?: unknown }).toolCallId)) &&
                  (result as { toolName?: unknown }).toolName === "read_webpage" &&
                  (result as { isError?: unknown }).isError !== true,
              ).length;
              control.recordBatchEvidence({ successfulSearches, successfulFetches });
            }
            if (online && toolSessions !== undefined) {
              const snapshot = toolSessions.budgetSnapshot(request.requestId);
              control.observeSnapshot(snapshot);
              if (hasToolCalls(message)) {
                control.completeBatch();
                const plan = plans.get(message);
                if (plan !== undefined) {
                  const currentDecisions = assistantToolCalls(message).flatMap((call) => {
                    const decision = decisionsByCallId.get(call.id);
                    return decision === undefined ? [] : [decision];
                  });
                  latestBatchSummary = {
                    requested: currentDecisions.length,
                    executed: currentDecisions.filter(
                      (decision) => decision.disposition === "admitted",
                    ).length,
                    reused: currentDecisions.filter(
                      (decision) => decision.disposition === "reused",
                    ).length,
                    skipped: currentDecisions.filter(
                      (decision) => decision.disposition === "skipped",
                    ).length,
                    remaining: {
                      web_search: snapshot.categories.search.remaining,
                      read_webpage: snapshot.categories.fetch.remaining,
                    },
                    availableToolsNextTurn: control.availableNetworkTools(),
                  };
                }
              }
            }
            if (mustReserveLastTurn || toolPhaseFinished) control.requestSynthesis();
            if (!mustReserveLastTurn && !toolPhaseFinished && control.phase() !== "synthesizing") {
              return {
                context: {
                  ...context,
                  systemPrompt: composeSystemPrompt(),
                  tools: filterRuntimeTools(requestTools, control.availableNetworkTools()),
                },
              };
            }
            if (!online && !mustReserveLastTurn) {
              return undefined;
            }
            streamAnswer = true;
            if (toolPhaseFinished && !synthesisFollowUpSent) {
              synthesisFollowUpPending = true;
              synthesisFollowUpSent = true;
              agent.followUp({ role: "user", content: SYNTHESIS_USER_PROMPT, timestamp: Date.now() });
            }
            return {
              context: {
                ...context,
                systemPrompt: `${composeSystemPrompt()}\n${SYNTHESIS_SYSTEM_PROMPT}`,
                tools: [],
              },
            };
          },
          shouldStopAfterTurn: ({ message, newMessages }) => {
            if (request.toolAccess.network === "enabled") {
              if (synthesisFollowUpPending) return false;
              if (streamAnswer && !hasToolCalls(message)) return true;
            }
            return assistantTurnCount(newMessages) >= request.toolAccess.maxAgentTurns;
          },
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
          if (event.type === "message_update") {
            if (
              streamAnswer &&
              event.assistantMessageEvent.type === "text_delta" &&
              event.assistantMessageEvent.delta.length > 0
            ) {
              synthesisFollowUpPending = false;
              streamedAnswer += event.assistantMessageEvent.delta;
              emit({
                requestId: request.requestId,
                type: "text_delta",
                delta: event.assistantMessageEvent.delta,
              });
            }
            return;
          }
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
            const decision = decisionsByCallId.get(event.toolCallId);
            const scope = batchScopeByCallId.get(event.toolCallId);
            if (decision?.disposition === "skipped") {
              emitActivity(activity, "skipped", {
                errorCode: "budget_trimmed",
                ...scope,
                budgetConsumed: false,
              });
            } else if (decision?.disposition === "reused") {
              const outcome =
                (decision.priorResult?.result as CachedPiToolOutcome | undefined) ??
                (decision.reusedFromId === undefined
                  ? undefined
                  : outcomesByCallId.get(decision.reusedFromId));
              emitActivity(activity, "reused", {
                ...(outcome?.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
                ...scope,
                budgetConsumed: false,
              });
            } else {
              emitActivity(activity, event.isError ? "failed" : "completed", scope);
            }
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
        if (streamedAnswer.length === 0) {
          emit({ requestId: request.requestId, type: "text_delta", delta: finalText });
        } else if (finalText.startsWith(streamedAnswer) && finalText.length > streamedAnswer.length) {
          emit({
            requestId: request.requestId,
            type: "text_delta",
            delta: finalText.slice(streamedAnswer.length),
          });
        }
        emitTerminal({ requestId: request.requestId, type: "completed", text: finalText });
      } finally {
        toolSessions?.releaseTrace(request.requestId);
      }
    },
  };
}
