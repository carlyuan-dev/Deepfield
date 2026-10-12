import { createHash, randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  ToolActor,
  ToolDefinition,
  ToolRunContext,
  ToolRunner,
  ToolRegistry,
  ToolSet,
} from "@deepfield/tool-platform";
import type { JsonObject, ToolExecutionBatchScope, ToolExecutionEvent } from "@deepfield/contracts";
import type { ModelToolOrigin } from "@deepfield/capability-sdk";
import { toolResultProjection } from "./tool-source-projection.js";

export interface PiToolAdapterContext extends ToolRunContext {
  toolSet: ToolSet;
  traceId: string;
  actor: ToolActor;
  projectId?: string;
  batchScopeFor?: (toolCallId: string) => ToolExecutionBatchScope | undefined;
}

export interface PiToolAdapterOptions {
  executionIdFactory?: () => string;
}

const MAX_DETERMINISTIC_TEXT_BYTES = 8192;
// Capability validation can inspect the trusted output without putting it in
// Pi history, renderer events or serialized diagnostics. Entries follow GC.
const successfulOutputs = new WeakMap<object, unknown>();
export function successfulToolOutput(result: object): unknown { return successfulOutputs.get(result); }

/** UTF-8-safe truncation that never splits a surrogate pair. */
function truncateUtf8(text: string, maxBytes: number): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let index = low;
  const last = text.charCodeAt(index - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    index -= 1; // a lone high surrogate at the boundary: cut the pair
  }
  return text.slice(0, index);
}

/** Deterministic, bounded JSON text used when a Definition has no formatter. */
export function deterministicOutputText(output: unknown): string {
  const serialized = JSON.stringify(output ?? null);
  if (serialized === undefined) {
    return "null";
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_DETERMINISTIC_TEXT_BYTES) {
    return serialized;
  }
  return `${truncateUtf8(serialized, MAX_DETERMINISTIC_TEXT_BYTES)}…(truncated)`;
}

export class PiToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiToolExecutionError";
  }
}

/**
 * Builds Pi AgentTools from the exact Registry definitions, filtered by the
 * trusted immutable ToolSet. Policy, budget, audit and retry are never
 * duplicated here: every execution goes through the shared ToolRunner.
 */
export function createPiAgentTools(
  registry: ToolRegistry,
  runner: ToolRunner,
  context: PiToolAdapterContext,
  options: PiToolAdapterOptions = {},
): AgentTool<any>[] {
  const executionIdFactory = options.executionIdFactory ?? (() => randomUUID());
  const tools: AgentTool<any>[] = [];
  for (const definition of registry.list()) {
    if (!context.toolSet.has(definition.identity)) {
      continue; // ToolSet 外工具不出现
    }
    tools.push(toAgentTool(definition, runner, context, executionIdFactory));
  }
  return tools;
}

function toAgentTool(
  definition: ToolDefinition<any, any>,
  runner: ToolRunner,
  context: PiToolAdapterContext,
  executionIdFactory: () => string,
): AgentTool<any> {
  return {
    name: definition.identity.name,
    description: definition.description,
    label: definition.label,
    parameters: definition.inputSchema,
    async execute(toolCallId, params, signal, onUpdate) {
      const batchScope = context.batchScopeFor?.(toolCallId);
      const runContext: ToolRunContext = {
        traceId: context.traceId,
        actor: context.actor,
        ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
        ...(batchScope ??
          (context.agentTurnIndex !== undefined
            ? {
                agentTurnIndex: context.agentTurnIndex,
                ...(context.batchId !== undefined ? { batchId: context.batchId } : {}),
              }
            : {})),
        toolSet: context.toolSet,
      };
      const executionId = executionIdFactory();
      const result = await runner.execute(
        {
          executionId,
          traceId: context.traceId,
          tool: definition.identity,
          input: params as unknown as JsonObject,
        },
        { ...runContext, toolCallId },
        signal ?? new AbortController().signal,
        (event: ToolExecutionEvent) => {
          if (event.type === "progress" && onUpdate !== undefined) {
            onUpdate({ content: [], details: { progress: event.progress } });
          }
        },
      );
      if (result.status === "completed") {
        const text =
          definition.model !== undefined
            ? definition.model.formatOutput(result.output)
            : deterministicOutputText(result.output);
        const original = JSON.stringify(result.output ?? null);
        const projection = toolResultProjection({ content: [{ type: "text", text }] }, definition.identity.name === "web_search");
        const modelOrigin: ModelToolOrigin = {
          toolName: definition.identity.name,
          sources: (projection.sources ?? []).map((source, sourceIndex) => ({ ...source,
            ...(definition.identity.name === "web_search" ? (() => {
              // Canonical search formatting preserves each normalized rank, including
              // duplicate URLs; absent rank cannot establish a metadata association.
              const rank = projection.sourceRanks?.[sourceIndex];
              const entry = rank === undefined ? undefined : (result.output as { results?: Array<{ rank: number; url: string; title: string; sourceDate?: ModelToolOrigin["sources"][number]["sourceDate"] }> }).results?.find(item => item.rank === rank && item.url === source.url);
              return entry ? { title: entry.title, ...(entry.sourceDate ? { sourceDate: entry.sourceDate } : {}) } : {};
            })() : {}),
            ...(definition.identity.name === "web_search" ? { kind: "search_snippet" as const } :
              definition.identity.name === "read_webpage" && typeof (result.output as { text?: unknown })?.text === "string" ? (() => {
                const page = result.output as { url?: string; requestedUrl?: string; finalUrl?: string };
                return { kind: "page_excerpt" as const, ...(page.url === source.url ? {
                  ...(page.requestedUrl === undefined ? {} : { requestedUrl: page.requestedUrl }),
                  ...(page.finalUrl === undefined ? {} : { finalUrl: page.finalUrl }),
                } : {}) };
              })() : {}),
          })),
          formatting: {
            version: definition.model ? `tool-format-v${definition.identity.version}` : "deterministic-json-v1",
            beforeBytes: Buffer.byteLength(original, "utf8"), beforeHash: createHash("sha256").update(original).digest("hex"),
            afterBytes: Buffer.byteLength(text, "utf8"), afterHash: createHash("sha256").update(text).digest("hex"),
            omittedItems: definition.identity.name === "web_search" && Array.isArray((result.output as { results?: unknown })?.results) ? (result.output as { results: unknown[] }).results.length - (projection.resultCount ?? 0) : null,
          },
        };
        const agentResult = {
          content: [{ type: "text" as const, text }],
          details: { executionId, budgetConsumed: result.budgetConsumed, ...(modelOrigin.sources.length ? { modelOrigin } : {}) },
        };
        successfulOutputs.set(agentResult, result.output);
        return agentResult;
      }
      const failure = result.failure ?? {
        code: "cancelled",
        message: "tool execution cancelled",
        retryable: false,
        attempts: result.attempts,
      };
      throw new PiToolExecutionError(
        `tool_failed ${JSON.stringify({
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          attempts: failure.attempts,
          budgetConsumed: result.budgetConsumed,
          ...(failure.code === "budget_exceeded"
            ? { instruction: "Do not call this tool again in this run. Use the results already collected and answer the user." }
            : {}),
        })}`,
      );
    },
  };
}
