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
  const unsubscribe = endpoint.onMessage((value) => handleInbound(value));

  function handleInbound(value: unknown): void {
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
    let settled = false;
    const controller = new AbortController();

    const emit = (event: unknown): void => {
      if (settled) {
        return;
      }
      if (!Value.Check(AgentWorkerEventSchema, event)) {
        if (safeRequestId(event) === request.requestId) {
          settled = true;
          endpoint.postMessage({
            requestId: request.requestId,
            type: "failed",
            code: "invalid_event",
            message: "agent emitted an invalid event",
          } satisfies AgentWorkerEvent);
        }
        return;
      }
      if (event.requestId !== request.requestId) {
        return;
      }
      if (event.type === "completed" || event.type === "failed") {
        settled = true;
      }
      endpoint.postMessage(event);
    };

    const fail = (): void => {
      if (!settled) {
        settled = true;
        endpoint.postMessage({
          requestId: request.requestId,
          type: "failed",
          code: "agent_error",
          message: "agent execution failed",
        } satisfies AgentWorkerEvent);
      }
    };

    void Promise.resolve()
      .then(() => chatAgent.run(request, emit, controller.signal))
      .catch(fail);
  }

  return {
    dispose() {
      unsubscribe();
    },
  };
}
