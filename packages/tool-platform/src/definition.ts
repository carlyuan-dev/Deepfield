import type { Static, TSchema } from "typebox";
import type { ToolIdentity } from "@deepfield/contracts";

export type ToolActor =
  | "main_agent"
  | "capability"
  | "child_agent"
  | "direct_ui"
  | "developer_probe";

export interface ToolRunContext {
  traceId: string;
  actor: ToolActor;
  projectId?: string;
}

export type ToolEffect =
  | "network.read.public"
  | "project.read"
  | "imported_file.read"
  | "external.open"
  | "document.write";

export interface ToolRetryPolicy {
  maxRetries: 0 | 1 | 2;
  backoffMs: number;
}

export type ToolMeterCategory = "search" | "fetch" | "link_check" | "parse" | "none";

export interface ToolMeter {
  category: ToolMeterCategory;
  countsBytes: boolean;
  countsTime: boolean;
}

export interface ToolProgress {
  kind: string;
  message?: string;
  bytes?: number;
  percent?: number;
}

export interface ToolExecutor<TInput, TOutput> {
  (
    input: TInput,
    context: ToolRunContext,
    signal: AbortSignal,
    onProgress?: (progress: ToolProgress) => void,
  ): Promise<TOutput>;
}

export interface ToolDefinition<TInput extends TSchema, TOutput extends TSchema> {
  identity: ToolIdentity;
  label: string;
  description: string;
  inputSchema: TInput;
  outputSchema: TOutput;
  effect: ToolEffect;
  timeoutMs: number;
  retry: ToolRetryPolicy;
  concurrency: number;
  meter: ToolMeter;
  model?: { formatOutput(output: Static<TOutput>): string };
  execute: ToolExecutor<Static<TInput>, Static<TOutput>>;
}
