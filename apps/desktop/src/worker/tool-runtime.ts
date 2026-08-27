import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  ToolBudgetLedger,
  ToolPolicy,
  ToolRegistry,
  ToolRunner,
  ToolSet,
} from "@deepfield/tool-platform";
import type { RetryClock, ToolAuditSink, ToolDefinition, ToolRunner as ToolRunnerType } from "@deepfield/tool-platform";
import type { ToolExecutionEvent, ToolRunRequest } from "@deepfield/contracts";
import type { ToolRuntime } from "./message-loop.js";
import { createPiAgentTools } from "./pi-tool-adapter.js";

class RealRetryClock implements RetryClock {
  now(): number {
    return Date.now();
  }

  wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (typeof timeout === "object" && "unref" in timeout) {
        timeout.unref();
      }
      const onAbort = (): void => {
        clearTimeout(timeout);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const probeInputSchema = Type.Object(
  { text: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const probeOutputSchema = Type.Object(
  { text: Type.String() },
  { additionalProperties: false },
);

/** Offline probe tool: no network, used by tests and the opt-in smoke. */
export function echoProbeDefinition(): ToolDefinition<typeof probeInputSchema, typeof probeOutputSchema> {
  return {
    identity: { name: "echo_probe", version: 1 },
    label: "Echo Probe",
    description: "Offline probe tool that echoes its text input (no network).",
    inputSchema: probeInputSchema,
    outputSchema: probeOutputSchema,
    effect: "project.read",
    timeoutMs: 5000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 4,
    meter: { category: "none", countsBytes: false, countsTime: true },
    model: { formatOutput: (output) => `probe: ${output.text}` },
    execute: async ({ text }) => ({ text }),
  };
}

/** Trusted immutable ToolSet for the Utility runtime assembly. */
export function createTrustedToolSet(): ToolSet {
  return new ToolSet([
    { identity: { name: "echo_probe", version: 1 }, actor: "main_agent", effect: "project.read" },
    { identity: { name: "echo_probe", version: 1 }, actor: "developer_probe", effect: "project.read" },
  ]);
}

export interface UtilityToolRuntime {
  run(
    request: ToolRunRequest,
    emit: (event: ToolExecutionEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
  registry: ToolRegistry;
  policy: ToolPolicy;
  budget: ToolBudgetLedger;
  runner: ToolRunnerType;
  audit: ToolAuditSink;
  createAgentTools(): ReturnType<typeof createPiAgentTools>;
}

export function createToolRuntime(options: { audit: ToolAuditSink; registerProbe?: boolean }): UtilityToolRuntime {
  const registry = new ToolRegistry();
  if (options.registerProbe !== false) {
    registry.register(echoProbeDefinition());
  }
  const policy = new ToolPolicy();
  const clock = new RealRetryClock();
  const budget = new ToolBudgetLedger(
    { maxCalls: 1000, maxConcurrency: 8, maxConcurrencyPerTool: 4 },
    () => clock.now(),
  );
  const runner = new ToolRunner({ registry, policy, budget, audit: options.audit, clock });
  const toolSet = createTrustedToolSet();
  return {
    registry,
    policy,
    budget,
    runner,
    audit: options.audit,
    async run(request, emit, signal) {
      await runner.execute(
        {
          executionId: request.executionId,
          traceId: request.traceId,
          tool: request.tool,
          input: request.input,
        },
        {
          traceId: request.traceId,
          actor: request.actor,
          ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
          toolSet,
        },
        signal,
        emit,
      );
    },
    createAgentTools() {
      return createPiAgentTools(registry, runner, {
        traceId: `utility-${randomUUID()}`,
        actor: "main_agent",
        toolSet,
      });
    },
  };
}

export type { ToolRuntime } from "./message-loop.js";
