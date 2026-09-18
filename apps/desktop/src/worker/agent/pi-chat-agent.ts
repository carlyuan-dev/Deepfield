import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  AgentWorkerEvent,
  SearchRuntimeSnapshot,
} from "@deepfield/contracts";
import type { SearchProvider } from "@deepfield/retrieval";
import type { ChatAgent } from "../message-loop.js";
import { createPiChatContextPreparer } from "../chat/pi-chat-context.js";
import { PiModelGateway, type ModelGateway } from "../../shared/model-gateway.js";
import { createMeteredSearchProvider } from "../../shared/usage-search.js";
import { createPiAgentExecutor } from "./pi-agent-executor.js";
import type { PiExecutionEvent, PiExecutionRequest } from "./pi-execution-contract.js";
import type { RuntimeSystemContextOptions } from "./runtime-system-context.js";
import {
  defaultPiRuntime,
  type PiRunDiagnostic,
  type PiRuntime,
  type PiToolSessionProvider,
  type SkillCatalogProvider,
} from "./pi-runtime.js";

export { PiChatAgentError, defaultPiRuntime } from "./pi-runtime.js";
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
): ChatAgent {
  const executor = createPiAgentExecutor(
    runtime,
    tools,
    skills,
    runtimeContext,
    toolSessions,
    gateway,
    searchProviderFactory,
    toolActor,
    diagnosticSink,
  );
  return {
    async run(request, emit, signal): Promise<void> {
      const executionRequest: PiExecutionRequest = {
        requestId: request.requestId,
        prompt: request.prompt,
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
      const prepareContext = createPiChatContextPreparer(toolActor, request, emit);
      const emitExecutionEvent = (event: PiExecutionEvent): void => {
        const workerEvent: AgentWorkerEvent = event;
        emit(workerEvent);
      };
      await executor.run(executionRequest, prepareContext, emitExecutionEvent, signal);
    },
  };
}
