import { withChildSearchBudget } from '../chat/child-search-budget.js';
import { convertToLlm, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createExecutionHandoff, type ExecutionHandoff } from "./execution-handoff.js";
import type {
  AgentWorkerEvent,
  SearchRuntimeSnapshot,
} from "@deepfield/contracts";
import type { SearchProvider } from "@deepfield/base/search";
import type { ChatAgent } from "../message-loop.js";
import { createPiChatContextPreparer } from "../chat/pi-chat-context.js";
import { createChatCollaborationSession, type ChatCollaborationDependencies, type CollaborationTurn } from '../chat/collaboration.js';
import { compactionMessages } from '../chat/compact-context.js';
import { createMemoryDependencyTransform } from "../chat/memory-dependencies.js";
import { createCompactContextTransform } from "../chat/compact-context.js";
import { PiModelGateway, type ModelGateway } from "../../shared/model-gateway.js";
import { createMeteredSearchProvider } from "../../shared/usage-search.js";
import { createPiAgentExecutor } from "./pi-agent-executor.js";
import { defaultPiRuntime } from "./pi-default-runtime.js";
import type { PiExecutionEvent, PiExecutionRequest } from "./pi-execution-contract.js";
import type { RuntimeSystemContextOptions } from "./runtime-system-context.js";
import {
  type PiRunDiagnostic,
  type PiRuntime,
  type PiToolSessionProvider,
  type SkillCatalogProvider,
} from "./pi-runtime.js";

export { PiChatAgentError } from "./pi-runtime.js";
export { defaultPiRuntime } from "./pi-default-runtime.js";
export type {
  PiAgentHandle,
  PiRunDiagnostic,
  PiRuntime,
  PiSession,
  PiToolSessionProvider,
  SkillCatalogProvider,
} from "./pi-runtime.js";

export function createPiChatAgent(
  runtime: PiRuntime = defaultPiRuntime(),
  tools: AgentTool<any>[] = [],
  skills?: SkillCatalogProvider,
  runtimeContext: RuntimeSystemContextOptions = {},
  toolSessions?: PiToolSessionProvider,
  gateway: ModelGateway = new PiModelGateway(),
  searchProviderFactory: (snapshot: SearchRuntimeSnapshot) => SearchProvider = createMeteredSearchProvider,
  toolActor: "main_agent" | "capability" = "main_agent",
  diagnosticSink?: (diagnostic: PiRunDiagnostic) => void,
  capabilityTools?: (request: import("@deepfield/contracts").AgentWorkerRequest, handoff: ExecutionHandoff) => AgentTool<any>[],
  memoryTransform?: (request: import("@deepfield/contracts").AgentWorkerRequest, actor?: "main_agent" | "child_agent") => NonNullable<import("./pi-execution-context.js").PreparedPiExecutionContext["transformContext"]>,
  collaboration?: ChatCollaborationDependencies,
): ChatAgent {
  const activeCollaboration = new Map<string, ReturnType<typeof createChatCollaborationSession>>();
  const executeTurn = async (request: import('@deepfield/contracts').AgentWorkerRequest, emit: (event: AgentWorkerEvent) => void, signal: AbortSignal, turn?: CollaborationTurn): Promise<AgentMessage[]> => {
      let timeline: AgentMessage[] = [];
      let releaseHandle: (() => void) | undefined;
      const actor = turn?.actor ?? toolActor;
      const observedRuntime: PiRuntime = turn?.onHandle ? { ...runtime, createAgent(options) { const handle = runtime.createAgent(options); releaseHandle = turn.onHandle!(handle); return handle; } } : runtime;
      if (toolActor === "main_agent" && /^\/compact(?:\s|$)/u.test(request.prompt.trim())) {
        const model = gateway.createModel(request.llm);
        const prepared = createPiChatContextPreparer(actor === "child_agent" ? "capability" : actor, request, emit)(model);
        const user = { role: "user" as const, content: request.prompt, timestamp: Date.now() };
        emit({ requestId: request.requestId, type: "started" });
        prepared.onMessageEnd?.(user);
        let compacted = false;
        const compact = createCompactContextTransform(request, prepared.messages.length, model, gateway, event => { if (event.type === "context_compacted") compacted = true; emit(event); });
        const dependencyProjection = collaboration ? createMemoryDependencyTransform(request.requestId, collaboration.host) : undefined;
        await compact(dependencyProjection ? await dependencyProjection([...prepared.messages, user]) : [...prepared.messages, user], signal);
        signal.throwIfAborted();
        const text = compacted ? "已整理当前对话上下文，原始聊天记录保留。可以继续。" : "当前对话较短，无需整理，可以继续。";
        emit({ requestId: request.requestId, type: "completed", text });
        return timeline;
      }
      const handoff = createExecutionHandoff();
      const turnToolSessions = toolSessions && turn?.maxSearchCalls !== undefined ? withChildSearchBudget(toolSessions, turn.maxSearchCalls) : toolSessions;
      const executor = createPiAgentExecutor(
        { runtime: observedRuntime, getApiKey: (snapshot, providerId) => gateway.getApiKey(snapshot, providerId), createSearchProvider: searchProviderFactory },
        { ...(turn?.hasPendingMessages ? { hasPendingMessages: turn.hasPendingMessages } : {}), tools: [...(actor === 'child_agent' ? [] : tools), ...(turn?.tools ?? []), ...(actor === 'child_agent' ? [] : capabilityTools?.(request, handoff) ?? [])], handoff, ...(skills === undefined ? {} : { skills }), runtimeContext,
          ...(turnToolSessions === undefined ? {} : { toolSessions: turnToolSessions }), toolActor: actor,
          ...(diagnosticSink === undefined ? {} : { diagnosticSink }) },
      );
      const executionRequest: PiExecutionRequest = {
        requestId: request.requestId,
        prompt: request.prompt,
        ...(request.context.humanPrompt === undefined ? {} : { humanPrompt: request.context.humanPrompt }),
        systemPrompt: request.context.systemPrompt,
        contextMessages: request.context.messages,
        ...(request.context.finalizationSystemPrompt === undefined
          ? {}
          : { finalizationSystemPrompt: request.context.finalizationSystemPrompt }),
        ...(request.options.skillName === undefined
          ? {}
          : { skillName: request.options.skillName }),
        ...(request.search === undefined ? {} : { search: request.search }),
        llm: request.llm,
        toolAccess: request.toolAccess,
      };
      const originalPrepare = createPiChatContextPreparer(actor === "child_agent" ? "capability" : actor, request, emit);
      const prepareContext: typeof originalPrepare = model => {
        const prepared = originalPrepare(model);
        if (turn?.messages) prepared.messages = turn.messages as typeof prepared.messages;
        if (turn?.contextMessages) prepared.messages = [...prepared.messages, ...turn.contextMessages] as typeof prepared.messages;
        timeline = [...prepared.messages];
        const onMessageEnd = prepared.onMessageEnd;
        const recording = { ...prepared, onMessageEnd: async (message: AgentMessage) => {
          timeline.push(message);
          if (turn?.onMessage) await turn.onMessage(message, timeline);
          else onMessageEnd?.(message);
        } };
        if (actor !== "main_agent" && actor !== "child_agent") return recording;
        const dependencyProjection = collaboration ? createMemoryDependencyTransform(turn?.memoryRequestId ?? request.requestId, collaboration.host) : undefined;
        const compact = createCompactContextTransform(request, prepared.messages.length, model, gateway, event => {
          if (event.type === 'context_compacted') timeline = compactionMessages(event.compaction);
          emit(event);
        }, dependencyProjection);
        const memory = memoryTransform && request.context.memory ? memoryTransform(turn?.memoryRequestId ? { ...request, requestId: turn.memoryRequestId } : request, actor) : undefined;
        return { ...recording, transformContext: async (messages, signal, framing) => {
          const validated = dependencyProjection ? await dependencyProjection(messages) : messages;
          const projected = await compact(validated, signal, framing);
          const revalidated = dependencyProjection ? await dependencyProjection(projected) : projected;
          const modelMessages = memory ? await memory(revalidated, signal, framing) : revalidated;
          turn?.onModelInput?.(modelMessages);
          return convertToLlm(modelMessages);
        } };
      };
      const emitExecutionEvent = (event: PiExecutionEvent): void => {
        const workerEvent: AgentWorkerEvent = event;
        emit(workerEvent);
      };
      try { await executor.run(executionRequest, prepareContext, emitExecutionEvent, signal); return timeline; }
      finally { releaseHandle?.(); }
  };
  return {
    cancelTask: async (requestId, taskId) => { await activeCollaboration.get(requestId)?.coordinator.cancel(taskId); },
    async run(request, emit, signal): Promise<void> {
      if (!collaboration || toolActor !== 'main_agent' || /^\/compact(?:\s|$)/u.test(request.prompt.trim())) { await executeTurn(request,emit,signal); return; }
      const session = createChatCollaborationSession(request,emit,signal,collaboration,executeTurn);
      activeCollaboration.set(request.requestId,session);
      try { await session.run(); } finally { activeCollaboration.delete(request.requestId); }
    },
  };
}
