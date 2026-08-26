import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";
import type { ChatAgent, WorkerEndpoint } from "./message-loop.js";

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
    apiKey: "sk-test-key",
    modelId: "deepseek-chat",
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
