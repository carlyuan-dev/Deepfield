import type {
  AgentWorkerEvent,
  AgentWorkerRequest,
  ToolExecutionEvent,
  ToolRunRequest,
} from "@deepfield/contracts";
import type { ChatAgent, ToolRuntime, WorkerEndpoint } from "./message-loop.js";

export class InMemoryEndpoint implements WorkerEndpoint {
  posted: unknown[] = [];
  private listeners = new Set<(value: unknown) => void>();

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  onMessage(listener: (value: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: unknown): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

export function request(requestId = "req-1"): AgentWorkerRequest {
  return {
    requestId,
    kind: "chat.prompt",
    prompt: "你好",
    context: { projectId: "p1", conversationId: "c1", systemPrompt: "sys", messages: [] },
    options: { webSearch: false },
    apiKey: "sk-test-key",
    modelId: "deepseek-v4-flash",
  };
}

export const echoAgent: ChatAgent = {
  async run(workerRequest, emit) {
    emit({ requestId: workerRequest.requestId, type: "started" });
    emit({ requestId: workerRequest.requestId, type: "text_delta", delta: "你好" });
    emit({ requestId: workerRequest.requestId, type: "completed", text: "你好" });
  },
};

export async function flushPending(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export function toolRunRequest(
  executionId = "exec-1",
  traceId = "trace-1",
  requestId = executionId,
): ToolRunRequest {
  return {
    requestId,
    kind: "tool.run",
    executionId,
    traceId,
    tool: { name: "echo", version: 1 },
    input: { text: "hi" },
    actor: "developer_probe",
  };
}

let toolSequence = 0;

export function toolEvent(
  executionId: string,
  traceId: string,
  type: ToolExecutionEvent["type"],
): ToolExecutionEvent {
  const base = {
    executionId,
    traceId,
    tool: { name: "echo", version: 1 },
    sequence: toolSequence++,
    timestamp: 0,
  };
  switch (type) {
    case "started":
      return { ...base, type: "started" };
    case "progress":
      return { ...base, type: "progress", progress: { kind: "progress" } };
    case "completed":
      return { ...base, type: "completed" };
    case "failed":
      return {
        ...base,
        type: "failed",
        failure: { code: "executor_failed", message: "x", retryable: false, attempts: 1 },
      };
    case "cancelled":
      return {
        ...base,
        type: "cancelled",
        failure: { code: "cancelled", message: "x", retryable: false, attempts: 1 },
      };
    default:
      throw new Error(`unexpected tool event type: ${type}`);
  }
}

export const echoToolRuntime: ToolRuntime = {
  async run(request, emit) {
    emit(toolEvent(request.executionId, request.traceId, "started"));
    emit(toolEvent(request.executionId, request.traceId, "completed"));
  },
};

export function toolEnvelope(
  requestId: string,
  executionId: string,
  traceId: string,
  type: ToolExecutionEvent["type"],
): { kind: "tool.event"; requestId: string; event: ToolExecutionEvent } {
  return { kind: "tool.event", requestId, event: toolEvent(executionId, traceId, type) };
}
