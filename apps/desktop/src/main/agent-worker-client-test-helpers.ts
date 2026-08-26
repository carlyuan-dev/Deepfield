import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";
import type { MessageEndpoint } from "./agent-worker-client.js";

export class FakeEndpoint implements MessageEndpoint {
  posted: unknown[] = [];
  private messageListeners = new Set<(value: unknown) => void>();
  private exitListeners = new Set<(code: number) => void>();

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  onMessage(listener: (value: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onExit(listener: (code: number) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  emit(value: unknown): void {
    for (const listener of [...this.messageListeners]) {
      listener(value);
    }
  }

  emitExit(code: number): void {
    for (const listener of [...this.exitListeners]) {
      listener(code);
    }
  }

  messageListenerCount(): number {
    return this.messageListeners.size;
  }

  exitListenerCount(): number {
    return this.exitListeners.size;
  }
}

export function request(requestId: string): AgentWorkerRequest {
  return {
    requestId,
    kind: "chat.prompt",
    prompt: "你好",
    context: { projectId: "p1", conversationId: "c1", systemPrompt: "sys", messages: [] },
    apiKey: "sk-test-key",
    modelId: "deepseek-v4-flash",
  };
}

export function event(
  requestId: string,
  type: AgentWorkerEvent["type"],
  text?: string,
): AgentWorkerEvent {
  switch (type) {
    case "started":
      return { requestId, type: "started" };
    case "text_delta":
      return { requestId, type: "text_delta", delta: text ?? "" };
    case "completed":
      return { requestId, type: "completed", text: text ?? "" };
    case "failed":
      return { requestId, type: "failed", code: text ?? "error", message: "boom" };
  }
}

export function label(item: AgentWorkerEvent): string {
  switch (item.type) {
    case "started":
      return "started";
    case "text_delta":
      return item.delta;
    case "completed":
      return `completed:${item.text}`;
    case "failed":
      return `failed:${item.code}`;
  }
}

export async function collect(stream: AsyncIterable<AgentWorkerEvent>): Promise<string[]> {
  const labels: string[] = [];
  for await (const item of stream) {
    labels.push(label(item));
  }
  return labels;
}

export async function collectUntilDelta(
  stream: AsyncIterable<AgentWorkerEvent>,
): Promise<string[]> {
  const labels: string[] = [];
  for await (const item of stream) {
    labels.push(label(item));
    if (item.type === "text_delta") {
      break;
    }
  }
  return labels;
}

export async function collectError(
  stream: AsyncIterable<AgentWorkerEvent>,
): Promise<{ labels: string[]; error: Error | undefined }> {
  const labels: string[] = [];
  let error: Error | undefined;
  try {
    for await (const item of stream) {
      labels.push(label(item));
    }
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  return { labels, error };
}
