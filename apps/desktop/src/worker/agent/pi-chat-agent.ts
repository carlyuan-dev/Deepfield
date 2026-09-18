import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentWorkerRequest } from "@deepfield/contracts";
import type { SearchProvider } from "@deepfield/retrieval";
import type { ChatAgent } from "../message-loop.js";
import { createPiChatContextPreparer } from "../chat/pi-chat-context.js";
import { PiModelGateway, type ModelGateway } from "../../shared/model-gateway.js";
import { createMeteredSearchProvider } from "../../shared/usage-search.js";
import { createPiAgentExecutor } from "./pi-agent-executor.js";
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
  searchProviderFactory: (snapshot: NonNullable<AgentWorkerRequest["search"]>) => SearchProvider = createMeteredSearchProvider,
  toolActor: "main_agent" | "capability" = "main_agent",
  diagnosticSink?: (diagnostic: PiRunDiagnostic) => void,
): ChatAgent {
  return createPiAgentExecutor(
    createPiChatContextPreparer(toolActor),
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
}
