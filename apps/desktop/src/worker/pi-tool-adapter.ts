import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  ToolActor,
  ToolDefinition,
  ToolRunContext,
  ToolRunner,
  ToolRegistry,
  ToolSet,
} from "@deepfield/tool-platform";
import type { JsonObject, ToolExecutionEvent } from "@deepfield/contracts";

export interface PiToolAdapterContext extends ToolRunContext {
  toolSet: ToolSet;
  traceId: string;
  actor: ToolActor;
  projectId?: string;
}

export interface PiToolAdapterOptions {
  executionIdFactory?: () => string;
}

const MAX_DETERMINISTIC_TEXT_LENGTH = 8192;

/** Deterministic, bounded JSON text used when a Definition has no formatter. */
export function deterministicOutputText(output: unknown): string {
  const serialized = JSON.stringify(output ?? null);
  if (serialized === undefined || serialized.length <= MAX_DETERMINISTIC_TEXT_LENGTH) {
    return serialized ?? "null";
  }
  return `${serialized.slice(0, MAX_DETERMINISTIC_TEXT_LENGTH)}…(truncated)`;
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
  const runContext: ToolRunContext = {
    traceId: context.traceId,
    actor: context.actor,
    ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
    toolSet: context.toolSet,
  };
  return {
    name: definition.identity.name,
    description: definition.description,
    label: definition.label,
    parameters: definition.inputSchema,
    async execute(toolCallId, params, signal, onUpdate) {
      const executionId = executionIdFactory();
      const result = await runner.execute(
        {
          executionId,
          traceId: context.traceId,
          tool: definition.identity,
          input: params as unknown as JsonObject,
        },
        runContext,
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
        return {
          content: [{ type: "text", text }],
          details: { executionId },
        };
      }
      if (result.status === "cancelled") {
        throw new PiToolExecutionError("tool execution cancelled");
      }
      throw new PiToolExecutionError("tool execution failed");
    },
  };
}
