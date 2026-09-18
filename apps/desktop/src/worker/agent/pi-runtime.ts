import type {
  AgentEvent,
  AgentMessage,
  AgentOptions,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts/model-config";
import type {
  ToolExecutionBatchScope,
  ToolSyntheticAuditRecord,
} from "@deepfield/contracts/tools";
import type { ToolBudgetSnapshot } from "@deepfield/tool-platform/budget-contract";
import type { SearchProvider } from "@deepfield/retrieval/search-provider";

export class PiChatAgentError extends Error {
  constructor(
    readonly code: "provider_failed" | "stream_failed" | "incomplete_lifecycle" | "invalid_final_empty" | "invalid_final_protocol" | "invalid_final_language" | "invalid_final_tool_use",
    message: string,
  ) {
    super(message);
    this.name = "PiChatAgentError";
  }
}

export interface SkillCatalogProvider {
  get(): Promise<{
    formatInvocation(name: string, instructions: string): string;
  }>;
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

export interface PiRunDiagnostic {
  traceId: string;
  phase: "deciding" | "synthesizing";
  agentTurns: number;
  searchCalls: number;
  fetchCalls: number;
  maxModelInputCharsEstimate: number;
  outputChars: number;
  stopReason: "stop" | "length" | "tool_use" | "error" | "aborted" | "unknown";
  errorCategory?: PiChatAgentError["code"];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
