import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  LlmRuntimeSnapshot,
  SearchRuntimeSnapshot,
} from "@deepfield/contracts";
import type { SearchProvider } from "@deepfield/retrieval";
import type { RuntimeSystemContextOptions } from "./runtime-system-context.js";
import type {
  PiRunDiagnostic,
  PiRuntime,
  PiToolSessionProvider,
  SkillCatalogProvider,
} from "./pi-runtime.js";

export interface PiAgentExecutorDependencies {
  runtime: PiRuntime;
  getApiKey: (
    snapshot: LlmRuntimeSnapshot,
    providerId: string,
  ) => Promise<string>;
  createSearchProvider: (snapshot: SearchRuntimeSnapshot) => SearchProvider;
}

export interface PiAgentExecutorOptions {
  tools?: AgentTool<any>[];
  skills?: SkillCatalogProvider;
  runtimeContext?: RuntimeSystemContextOptions;
  toolSessions?: PiToolSessionProvider;
  toolActor?: "main_agent" | "capability";
  diagnosticSink?: (diagnostic: PiRunDiagnostic) => void;
}
