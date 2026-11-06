import { convertToLlm, type AgentTool } from "@earendil-works/pi-agent-core";
import { createExecutionHandoff, type ExecutionHandoff } from "./execution-handoff.js";
import type {
  AgentWorkerEvent,
  SearchRuntimeSnapshot,
} from "@deepfield/contracts";
import type { SearchProvider } from "@deepfield/base/search";
import type { ChatAgent } from "../message-loop.js";
import { createPiChatContextPreparer } from "../chat/pi-chat-context.js";
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
  memoryTransform?: (request: import("@deepfield/contracts").AgentWorkerRequest) => NonNullable<import("./pi-execution-context.js").PreparedPiExecutionContext["transformContext"]>,
): ChatAgent {
  return {
    async run(request, emit, signal): Promise<void> {
      if (toolActor === "main_agent" && /^\/compact(?:\s|$)/u.test(request.prompt.trim())) {
        const model = gateway.createModel(request.llm);
        const prepared = createPiChatContextPreparer(toolActor, request, emit)(model);
        const user = { role: "user" as const, content: request.prompt, timestamp: Date.now() };
        emit({ requestId: request.requestId, type: "started" });
        prepared.onMessageEnd?.(user);
        let compacted = false;
        const compact = createCompactContextTransform(request, prepared.messages.length, model, gateway, event => { if (event.type === "context_compacted") compacted = true; emit(event); });
        await compact([...prepared.messages, user], signal);
        signal.throwIfAborted();
        const text = compacted ? "已整理当前对话上下文，原始聊天记录保留。可以继续。" : "当前对话较短，无需整理，可以继续。";
        emit({ requestId: request.requestId, type: "completed", text });
        return;
      }
      const handoff = createExecutionHandoff();
      const executor = createPiAgentExecutor(
        { runtime, getApiKey: (snapshot, providerId) => gateway.getApiKey(snapshot, providerId), createSearchProvider: searchProviderFactory },
        { tools: [...tools, ...(capabilityTools?.(request, handoff) ?? [])], handoff, ...(skills === undefined ? {} : { skills }), runtimeContext,
          ...(toolSessions === undefined ? {} : { toolSessions }), toolActor,
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
      const originalPrepare = createPiChatContextPreparer(toolActor, request, emit);
      const prepareContext: typeof originalPrepare = model => {
        const prepared = originalPrepare(model);
        if (toolActor !== "main_agent") return prepared;
        const compact = createCompactContextTransform(request, prepared.messages.length, model, gateway, emit);
        const memory = memoryTransform && request.context.memory ? memoryTransform(request) : undefined;
        return { ...prepared, transformContext: async (messages, signal, framing) => {
          const projected = await compact(messages, signal, framing);
          return convertToLlm(memory ? await memory(projected, signal, framing) : projected);
        } };
      };
      const emitExecutionEvent = (event: PiExecutionEvent): void => {
        const workerEvent: AgentWorkerEvent = event;
        emit(workerEvent);
      };
      await executor.run(executionRequest, prepareContext, emitExecutionEvent, signal);
    },
  };
}
