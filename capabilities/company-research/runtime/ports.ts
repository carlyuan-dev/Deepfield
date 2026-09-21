import type { PiExecutionRequest, PiExecutionEvent } from "@deepfield/capability-sdk";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts/model-config";
import type { CompanyResearchModelDiagnostic } from "../contracts/research.js";
export interface ModelCompletionResult { text: string; stopReason: "stop" | "length" | "tool_use" | "error" | "aborted" | "unknown" }
export interface ModelGateway {
  completeText(snapshot: LlmRuntimeSnapshot, system: string, prompt: string, signal?: AbortSignal): Promise<string>;
  completeTextResult?(snapshot: LlmRuntimeSnapshot, system: string, prompt: string, signal?: AbortSignal): Promise<ModelCompletionResult>;
}
export type ExecutionErrorCode = "provider_failed" | "stream_failed" | "incomplete_lifecycle" | "invalid_final_empty" | "invalid_final_protocol" | "invalid_final_language" | "invalid_final_tool_use";
export type RunDiagnostic = Omit<CompanyResearchModelDiagnostic, "phase" | "type" | "requestId" | "runId" | "stage"> & { phase: "deciding" | "synthesizing" };
export interface CompanyAgent {
  run(request: PiExecutionRequest, emit: (event: PiExecutionEvent) => void, signal: AbortSignal): Promise<void>;
}
export interface CompanyAgentRuntime {
  gateway: ModelGateway;
  createAgent(options: { diagnostic?: (value: RunDiagnostic) => void; allowedTools?: readonly string[]; onToolOutput?: (name: string, output: unknown) => void }): CompanyAgent;
  classifyError(error: unknown): ExecutionErrorCode | undefined;
}
