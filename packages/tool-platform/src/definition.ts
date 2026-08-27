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
  readonly maxRetries: 0 | 1 | 2;
  readonly backoffMs: number;
}

export type ToolMeterCategory = "search" | "fetch" | "link_check" | "parse" | "none";

export interface ToolMeter {
  readonly category: ToolMeterCategory;
  readonly countsBytes: boolean;
  readonly countsTime: boolean;
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
  readonly identity: ToolIdentity;
  readonly label: string;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  readonly effect: ToolEffect;
  readonly timeoutMs: number;
  readonly retry: ToolRetryPolicy;
  readonly concurrency: number;
  readonly meter: ToolMeter;
  readonly model?: { readonly formatOutput: (output: Static<TOutput>) => string };
  readonly execute: ToolExecutor<Static<TInput>, Static<TOutput>>;
}
