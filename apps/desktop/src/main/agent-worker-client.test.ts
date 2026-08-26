import { describe, expect, it } from "vitest";
import {
  AgentProtocolError,
  AgentWorkerClient,
  AgentWorkerExitedError,
  AgentWorkerQueueOverflowError,
  type MessageEndpoint,
} from "./agent-worker-client.js";
import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";

class FakeEndpoint implements MessageEndpoint {
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

function request(requestId: string): AgentWorkerRequest {
  return {
    requestId,
    kind: "chat.prompt",
    prompt: "你好",
    context: { projectId: "p1", conversationId: "c1", systemPrompt: "sys", messages: [] },
    apiKey: "sk-test-key",
    modelId: "deepseek-chat",
  };
}

function event(requestId: string, type: AgentWorkerEvent["type"], text?: string): AgentWorkerEvent {
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

function label(item: AgentWorkerEvent): string {
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

async function collect(stream: AsyncIterable<AgentWorkerEvent>): Promise<string[]> {
  const labels: string[] = [];
  for await (const item of stream) {
    labels.push(label(item));
  }
  return labels;
}

async function collectUntilDelta(stream: AsyncIterable<AgentWorkerEvent>): Promise<string[]> {
  const labels: string[] = [];
  for await (const item of stream) {
    labels.push(label(item));
    if (item.type === "text_delta") {
      break;
    }
  }
  return labels;
}

async function collectError(
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

describe("agent worker client", () => {
  it("delivers interleaved streams in per-request order and consumes terminal events", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const first = client.send(request("req-1"));
    const second = client.send(request("req-2"));
    endpoint.emit(event("req-2", "text_delta", "B"));
    endpoint.emit(event("req-1", "text_delta", "A"));
    endpoint.emit(event("req-1", "completed", "A"));
    expect(await collect(first)).toEqual(["A", "completed:A"]);
    expect(await collectUntilDelta(second)).toEqual(["B"]);
  });

  it("posts the request to the endpoint and buffers synchronous responses", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const req = request("req-1");
    const stream = client.send(req);
    endpoint.emit(event("req-1", "text_delta", "X"));
    endpoint.emit(event("req-1", "completed", "X"));
    expect(endpoint.posted).toEqual([req]);
    expect(await collect(stream)).toEqual(["X", "completed:X"]);
  });

  it("cleans pending when postMessage throws", () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    endpoint.postMessage = () => {
      throw new Error("post failed");
    };
    expect(() => client.send(request("req-1"))).toThrow(/post failed/);
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects duplicate request ids while the first is pending", () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    client.send(request("req-1"));
    expect(() => client.send(request("req-1"))).toThrow(/duplicate request/);
  });

  it("ignores events with unknown request ids without creating queues", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const stream = client.send(request("req-1"));
    endpoint.emit(event("ghost", "text_delta", "G"));
    expect(client.pendingCount()).toBe(1);
    endpoint.emit(event("req-1", "completed", "done"));
    expect(await collect(stream)).toEqual(["completed:done"]);
  });

  it("closes only the matching stream on a malformed event", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const good = client.send(request("req-1"));
    const bad = client.send(request("req-2"));
    endpoint.emit(event("req-1", "text_delta", "ok"));
    endpoint.emit({ requestId: "req-2", type: "text_delta" });
    const badResult = await collectError(bad);
    expect(badResult.error).toBeInstanceOf(AgentProtocolError);
    endpoint.emit(event("req-1", "completed", "ok"));
    expect(await collect(good)).toEqual(["ok", "completed:ok"]);
  });

  it("closes all pending streams with AgentWorkerExitedError on exit", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const a = client.send({ ...request("req-1"), prompt: "super-secret-prompt", apiKey: "sk-secret-api-key" });
    const b = client.send(request("req-2"));
    endpoint.emitExit(1);
    const resultA = await collectError(a);
    const resultB = await collectError(b);
    expect(resultA.error).toBeInstanceOf(AgentWorkerExitedError);
    expect(resultB.error).toBeInstanceOf(AgentWorkerExitedError);
    expect(resultA.error?.message).not.toContain("super-secret-prompt");
    expect(resultA.error?.message).not.toContain("sk-secret-api-key");
    expect(resultA.error?.message).not.toContain("req-1");
  });

  it("closes a stream when the unconsumed queue exceeds 1000 events", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const stream = client.send(request("req-1"));
    for (let index = 0; index <= 1000; index += 1) {
      endpoint.emit(event("req-1", "text_delta", `d${index}`));
    }
    const result = await collectError(stream);
    expect(result.error).toBeInstanceOf(AgentWorkerQueueOverflowError);
    expect(client.pendingCount()).toBe(0);
  });

  it("releases the request id when the consumer stops early", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const stream = client.send(request("req-1"));
    endpoint.emit(event("req-1", "text_delta", "B"));
    expect(await collectUntilDelta(stream)).toEqual(["B"]);
    expect(client.pendingCount()).toBe(0);
    const again = client.send(request("req-1"));
    endpoint.emit(event("req-1", "completed", "x"));
    expect(await collect(again)).toEqual(["completed:x"]);
  });

  it("dispose removes listeners and closes pending streams", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const stream = client.send(request("req-1"));
    expect(endpoint.messageListenerCount()).toBe(1);
    expect(endpoint.exitListenerCount()).toBe(1);
    client.dispose();
    expect(endpoint.messageListenerCount()).toBe(0);
    expect(endpoint.exitListenerCount()).toBe(0);
    const result = await collectError(stream);
    expect(result.error?.message).toContain("disposed");
    endpoint.emit(event("req-1", "completed", "x"));
    expect(client.pendingCount()).toBe(0);
  });
});
