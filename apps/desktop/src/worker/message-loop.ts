import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  AgentWorkerRequestSchema,
  ToolExecutionEventSchema,
  ToolRunRequestSchema,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
  type ToolExecutionEvent,
  type ToolRunRequest,
} from "@deepfield/contracts";

export interface ChatAgent {
  run(
    request: AgentWorkerRequest,
    emit: (event: AgentWorkerEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Tool executions are routed to a trusted Utility-side runtime. */
export interface ToolRuntime {
  run(
    request: ToolRunRequest,
    emit: (event: ToolExecutionEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface WorkerEndpoint {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): () => void;
}

export interface WorkerLoop {
  dispose(): void;
  activeCount(): number;
}

export interface WorkerMessageLoopOptions {
  toolRuntime?: ToolRuntime;
  hostReplyHandler?: (reply: unknown) => void;
}

interface ActiveExecution {
  controller: AbortController;
  settled: boolean;
  settle: (code: string, message: string, abortSignal: boolean) => void;
  finalize: () => void;
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const requestId = (value as { requestId?: unknown }).requestId;
  if (typeof requestId === "string") {
    return requestId;
  }
  return undefined;
}

function isHostReply(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { hostRequestId?: unknown; kind?: unknown };
  return (
    typeof record.hostRequestId === "string" &&
    record.hostRequestId.length > 0 &&
    record.kind === "host.reply"
  );
}

export function createWorkerMessageLoop(
  endpoint: WorkerEndpoint,
  chatAgent: ChatAgent,
  options: WorkerMessageLoopOptions = {},
): WorkerLoop {
  const active = new Map<string, ActiveExecution>();
  let disposed = false;
  const unsubscribe = endpoint.onMessage((value) => handleInbound(value));

  function handleInbound(value: unknown): void {
    if (disposed) {
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
    const execution = begin(request.requestId);
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
      .then(() => chatAgent.run(request, emit, execution.controller.signal))
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
      endpoint.postMessage({
        executionId: request.executionId,
        traceId: request.traceId,
        tool: request.tool,
        sequence: 0,
        timestamp: Date.now(),
        type: "failed",
        failure: {
          code: "tool_not_found",
          message: "tool execution is not available",
          retryable: false,
          attempts: 1,
        },
      } satisfies ToolExecutionEvent);
      return;
    }
    const execution = begin(request.requestId);
    if (!execution) {
      return;
    }
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
        endpoint.postMessage(event);
        return;
      }
      endpoint.postMessage(event);
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

  /** Registers an active execution; returns undefined on duplicate ids. */
  function begin(requestId: string): ActiveExecution | undefined {
    const existing = active.get(requestId);
    if (existing) {
      existing.settle("duplicate_request", "a request with this id is already active", true);
      return undefined;
    }
    const controller = new AbortController();
    const execution: ActiveExecution = {
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
    };
    execution.settle = (code: string, message: string, abortSignal: boolean): void => {
      if (execution.settled) {
        return;
      }
      finalize();
      if (abortSignal) {
        execution.controller.abort();
      }
      if (!disposed) {
        endpoint.postMessage({
          requestId,
          type: "failed",
          code,
          message,
        } satisfies AgentWorkerEvent);
      }
    };
    execution.finalize = finalize;
    active.set(requestId, execution);
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
    },
    activeCount() {
      return active.size;
    },
  };
}
