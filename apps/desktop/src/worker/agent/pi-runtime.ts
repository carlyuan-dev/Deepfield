import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolExecutionBatchScope, ToolSyntheticAuditRecord } from "@deepfield/contracts/tools";
import type { ToolBudgetSnapshot } from "@deepfield/base/tools";
import type { SearchProvider } from "@deepfield/base/search";
import type { ModelToolOrigin } from "@deepfield/capability-sdk/model-observation";
import type { PiRuntime as BasePiRuntime, PiAgentError } from "@deepfield/base/agent/runtime";
export { PiAgentError as PiChatAgentError } from "@deepfield/base/agent/runtime";
export type { PiSession, PiAgentHandle } from "@deepfield/base/agent/runtime";
export type PiRuntime = BasePiRuntime<ModelToolOrigin, "ordinary" | "synthesis">;

export interface SkillCatalogProvider {
  get(): Promise<{
    formatInvocation(name: string, instructions: string): string;
  }>;
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
  errorCategory?: PiAgentError["code"];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}
