import type { AgentWorkerEvent, AgentWorkerRequest, ToolExecutionEvent, ToolRunRequest } from "@deepfield/contracts";
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
    context: { conversationId: "c1", systemPrompt: "sys", messages: [] },
    options: { webSearch: false },
    llm: {
      id: "llm-test",
      name: "DeepSeek",
      provider: "deepseek",
      protocol: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-v4-flash",
      contextWindow: 128_000,
      apiKey: "sk-test-key",
    },
    toolAccess: { network: "disabled", maxAgentTurns: 6, maxSearchCalls: 0, maxFetchCalls: 0 },
  };
}

export function event(
  requestId: string,
  type: Exclude<AgentWorkerEvent["type"], "tool_activity">,
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
    case "tool_activity":
      return `tool:${item.status}:${item.name}`;
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

export function toolRequest(id = "exec-1", traceId = "trace-1", requestId = id): ToolRunRequest {
  return {
    requestId,
    kind: "tool.run",
    executionId: id,
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
    case "retry_scheduled":
      return { ...base, type: "retry_scheduled", retryDelayMs: 0 };
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

export function toolLabel(item: ToolExecutionEvent): string {
  return item.type;
}

export async function collectTool(
  stream: AsyncIterable<ToolExecutionEvent>,
): Promise<string[]> {
  const labels: string[] = [];
  for await (const item of stream) {
    labels.push(toolLabel(item));
  }
  return labels;
}

export async function collectToolError(
  stream: AsyncIterable<ToolExecutionEvent>,
): Promise<{ labels: string[]; error: Error | undefined }> {
  const labels: string[] = [];
  let error: Error | undefined;
  try {
    for await (const item of stream) {
      labels.push(toolLabel(item));
    }
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
  }
  return { labels, error };
}

export function toolEnvelope(
  requestId: string,
  executionId: string,
  traceId: string,
  type: ToolExecutionEvent["type"],
): { kind: "tool.event"; requestId: string; event: ToolExecutionEvent } {
  return { kind: "tool.event", requestId, event: toolEvent(executionId, traceId, type) };
}
