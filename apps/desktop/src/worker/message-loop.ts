import { Value } from "typebox/value";
import { UsageFlushRequestSchema } from "@deepfield/contracts";
import { withUsageContext } from "../shared/usage-collection.js";
import { AgentWorkerEventSchema, AgentWorkerRequestSchema, ToolExecutionEventSchema, ToolRunRequestSchema, type AgentWorkerEvent, type AgentWorkerRequest, type ToolExecutionEvent, type ToolRunRequest } from "@deepfield/contracts";
import type { WorkerCapabilityRegistry } from "./capabilities/registry.js";
import {
  isHostReply,
  safeRequestId,
  toolEnvelope,
  toolFailedEnvelope,
  type ActiveExecution,
  type ChatAgent,
  type ToolRuntime,
  type WorkerEndpoint,
  type WorkerLoop,
} from "./message-loop-types.js";

export type { ActiveExecution, ChatAgent, ToolRuntime, WorkerEndpoint, WorkerLoop } from "./message-loop-types.js";

export interface WorkerMessageLoopOptions {
  flushUsage?: () => Promise<void>;
  toolRuntime?: ToolRuntime;
  capabilities?: WorkerCapabilityRegistry;
  hostReplyHandler?: (reply: unknown) => void;
  /** Called once when the loop is disposed (e.g. to dispose the HostClient). */
  onDispose?: () => void;
}

export function createWorkerMessageLoop(
  endpoint: WorkerEndpoint,
  chatAgent: ChatAgent,
  options: WorkerMessageLoopOptions = {},
): WorkerLoop {
  const active = new Map<string, ActiveExecution>();
  const activeExecutions = new Map<string, ActiveExecution>();
  let disposed = false;
  const unsubscribe = endpoint.onMessage((value) => handleInbound(value));

  function handleInbound(value: unknown): void {
    if (disposed) {
      return;
    }
    if (Value.Check(UsageFlushRequestSchema, value)) {
      for (const execution of active.values()) execution.controller.abort();
      options.capabilities?.abortAll();
      void Promise.resolve().then(() => options.flushUsage?.()).catch(() => {}).then(() => {
        endpoint.postMessage({ kind: "usage.flushed", requestId: value.requestId });
      });
      return;
    }
    if (isHostReply(value)) {
      options.hostReplyHandler?.(value);
      return;
    }
    if (Value.Check(AgentWorkerRequestSchema, value)) {
      startChat(value);
      return;
    }
    if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "capability.run") {
      const id = safeRequestId(value);
      const existing = id === undefined ? undefined : active.get(id);
      if (existing) { existing.settle("duplicate_request", "a request with this id is already active", true); return; }
    }
    if (options.capabilities?.handle(value)) return;
    if (Value.Check(ToolRunRequestSchema, value)) {
      startTool(value);
      return;
    }
    const requestId = safeRequestId(value);
    if (requestId !== undefined) {
      endpoint.postMessage({
        requestId,
        type: "failed",
        code: "invalid_request",
        message: "invalid agent worker request",
      } satisfies AgentWorkerEvent);
    }
  }

  function startChat(request: AgentWorkerRequest): void {
    const execution = begin(request.requestId, "chat");
    if (!execution) {
      return;
    }
    const emit = (event: unknown): void => {
      if (disposed || execution.settled) {
        return;
      }
      if (
        !Value.Check(AgentWorkerEventSchema, event) ||
        safeRequestId(event) !== request.requestId
      ) {
        execution.settle("invalid_event", "agent emitted an invalid event", true);
        return;
      }
      if (event.type === "completed" || event.type === "failed") {
        execution.finalize();
        endpoint.postMessage(event);
        return;
      }
      endpoint.postMessage(event);
    };

    void Promise.resolve()
      .then(() => withUsageContext({ sourceId: "chat", taskId: request.requestId }, () => chatAgent.run(request, emit, execution.controller.signal)))
      .then(() => {
        if (!execution.settled && !disposed) {
          execution.settle(
            "agent_no_terminal_event",
            "agent finished without a terminal event",
            false,
          );
        }
      })
      .catch(() => {
        execution.settle("agent_error", "agent execution failed", false);
      });
  }

  function startTool(request: ToolRunRequest): void {
    const runtime = options.toolRuntime;
    if (!runtime) {
      postToolTerminal(
        request.requestId,
        request.executionId,
        request.traceId,
        request.tool,
        "tool_not_found",
        "tool execution is not available",
      );
      return;
    }
    if (activeExecutions.has(request.executionId)) {
      // A second execution for an already-active logical id is refused; the
      // first execution keeps running (its transport generation stays unique).
      postToolTerminal(
        request.requestId,
        request.executionId,
        request.traceId,
        request.tool,
        "duplicate_execution",
        "tool execution id already active",
      );
      return;
    }
    const execution = begin(request.requestId, "tool", request.executionId);
    if (!execution) {
      return;
    }
    execution.traceId = request.traceId;
    execution.tool = request.tool;
    const emit = (event: unknown): void => {
      if (disposed || execution.settled) {
        return;
      }
      if (
        !Value.Check(ToolExecutionEventSchema, event) ||
        (event as ToolExecutionEvent).executionId !== request.executionId ||
        (event as ToolExecutionEvent).traceId !== request.traceId
      ) {
        execution.settle("invalid_event", "agent emitted an invalid tool event", true);
        return;
      }
      if (
        event.type === "completed" ||
        event.type === "failed" ||
        event.type === "cancelled"
      ) {
        execution.finalize();
        endpoint.postMessage(toolEnvelope(request.requestId, event));
        return;
      }
      endpoint.postMessage(toolEnvelope(request.requestId, event));
    };

    void Promise.resolve()
      .then(() => runtime.run(request, emit, execution.controller.signal))
      .then(() => {
        if (!execution.settled && !disposed) {
          execution.settle(
            "agent_no_terminal_event",
            "tool finished without a terminal event",
            false,
          );
        }
      })
      .catch(() => {
        execution.settle("tool_error", "tool execution failed", false);
      });
  }

  function postToolTerminal(
    requestId: string,
    executionId: string,
    traceId: string,
    tool: { name: string; version: number },
    code: string,
    message: string,
  ): void {
    if (disposed) {
      return;
    }
    endpoint.postMessage(
      toolFailedEnvelope(requestId, executionId, traceId, tool, code, message, Date.now()),
    );
  }

  /** Registers an active execution; returns undefined on duplicate transport ids. */
  function begin(
    requestId: string,
    kind: "chat" | "tool",
    executionId?: string,
  ): ActiveExecution | undefined {
    if (options.capabilities?.has(requestId)) { options.capabilities.rejectDuplicate(requestId); return undefined; }
    const existing = active.get(requestId);
    if (existing) {
      existing.settle("duplicate_request", "a request with this id is already active", true);
      return undefined;
    }
    const controller = new AbortController();
    const execution: ActiveExecution = {
      kind,
      requestId,
      ...(executionId !== undefined ? { executionId } : {}),
      controller,
      settled: false,
      settle: () => {},
      finalize: () => {},
    };
    const finalize = (): void => {
      if (execution.settled) {
        return;
      }
      execution.settled = true;
      active.delete(requestId);
      if (executionId !== undefined) {
        activeExecutions.delete(executionId);
      }
    };
    execution.settle = (code: string, message: string, abortSignal: boolean): void => {
      if (execution.settled) {
        return;
      }
      finalize();
      if (abortSignal) {
        execution.controller.abort();
      }
      if (disposed) {
        return;
      }
      if (
        execution.kind === "tool" &&
        execution.executionId !== undefined &&
        execution.traceId !== undefined &&
        execution.tool !== undefined
      ) {
        endpoint.postMessage(
          toolFailedEnvelope(
            requestId,
            execution.executionId,
            execution.traceId,
            execution.tool,
            code,
            message,
            Date.now(),
          ),
        );
        return;
      }
      endpoint.postMessage({
        requestId,
        type: "failed",
        code,
        message,
      } satisfies AgentWorkerEvent);
    };
    execution.finalize = finalize;
    active.set(requestId, execution);
    if (executionId !== undefined) {
      activeExecutions.set(executionId, execution);
    }
    return execution;
  }

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      for (const execution of active.values()) {
        execution.settled = true;
        execution.controller.abort();
      }
      active.clear();
      activeExecutions.clear();
      void options.capabilities?.dispose();
      options.onDispose?.();
    },
    activeCount() {
      return active.size + (options.capabilities?.activeCount() ?? 0);
    },
  };
}
