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
  const active = new Map<string, AbortController>();
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
    if (active.has(request.requestId)) {
      endpoint.postMessage({
        requestId: request.requestId,
        type: "failed",
        code: "duplicate_request",
        message: "a request with this id is already active",
      } satisfies AgentWorkerEvent);
      return;
    }

    const controller = new AbortController();
    active.set(request.requestId, controller);
    let settled = false;

    const settle = (code: string, message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      active.delete(request.requestId);
      if (!disposed) {
        endpoint.postMessage({
          requestId: request.requestId,
          type: "failed",
          code,
          message,
        } satisfies AgentWorkerEvent);
      }
    };

    const emit = (event: unknown): void => {
      if (disposed || settled) {
        return;
      }
      if (!Value.Check(AgentWorkerEventSchema, event) || safeRequestId(event) !== request.requestId) {
        settle("invalid_event", "agent emitted an invalid event");
        return;
      }
      if (event.type === "completed" || event.type === "failed") {
        settled = true;
        active.delete(request.requestId);
        endpoint.postMessage(event);
        return;
      }
      endpoint.postMessage(event);
    };

    void Promise.resolve()
      .then(() => chatAgent.run(request, emit, controller.signal))
      .then(() => {
        if (!settled && !disposed) {
          settle("agent_no_terminal_event", "agent finished without a terminal event");
        }
      })
      .catch(() => {
        settle("agent_error", "agent execution failed");
      });
  }

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      for (const controller of active.values()) {
        controller.abort();
      }
      active.clear();
    },
    activeCount() {
      return active.size;
    },
  };
}
