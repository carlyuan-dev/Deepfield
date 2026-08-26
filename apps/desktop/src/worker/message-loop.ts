import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  AgentWorkerRequestSchema,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from "@deepfield/contracts";

export interface ChatAgent {
  run(
    request: AgentWorkerRequest,
    emit: (event: AgentWorkerEvent) => void,
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

interface ActiveExecution {
  controller: AbortController;
  settled: boolean;
  settle: (code: string, message: string, abortSignal: boolean) => void;
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null) {
    const requestId = (value as { requestId?: unknown }).requestId;
    if (typeof requestId === "string") {
      return requestId;
    }
  }
  return undefined;
}

export function createWorkerMessageLoop(endpoint: WorkerEndpoint, chatAgent: ChatAgent): WorkerLoop {
  const active = new Map<string, ActiveExecution>();
  let disposed = false;
  const unsubscribe = endpoint.onMessage((value) => handleInbound(value));

  function handleInbound(value: unknown): void {
    if (disposed) {
      return;
    }
    if (!Value.Check(AgentWorkerRequestSchema, value)) {
      const requestId = safeRequestId(value);
      if (requestId !== undefined) {
        endpoint.postMessage({
          requestId,
          type: "failed",
          code: "invalid_request",
          message: "invalid agent worker request",
        } satisfies AgentWorkerEvent);
      }
      return;
    }

    const request = value;
    const existing = active.get(request.requestId);
    if (existing) {
      existing.settle("duplicate_request", "a request with this id is already active", true);
      return;
    }

    const controller = new AbortController();
    const execution: ActiveExecution = {
      controller,
      settled: false,
      settle: () => {},
    };
    const finalize = (): void => {
      if (execution.settled) {
        return;
      }
      execution.settled = true;
      active.delete(request.requestId);
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
          requestId: request.requestId,
          type: "failed",
          code,
          message,
        } satisfies AgentWorkerEvent);
      }
    };
    active.set(request.requestId, execution);

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
        finalize();
        endpoint.postMessage(event);
        return;
      }
      endpoint.postMessage(event);
    };

    void Promise.resolve()
      .then(() => chatAgent.run(request, emit, controller.signal))
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
