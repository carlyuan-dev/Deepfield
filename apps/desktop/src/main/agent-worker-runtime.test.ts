import { describe, expect, it } from "vitest";
import { createAgentWorkerRuntime, type AgentWorkerChild } from "./agent-worker-runtime.js";
import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";

class FakeChild implements AgentWorkerChild {
  posted: unknown[] = [];
  killed = false;
  private messageListeners = new Set<(value: unknown) => void>();
  private exitListeners = new Set<(code: number) => void>();

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  on(event: "message", listener: (value: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  on(
    event: "message" | "exit",
    listener: ((value: unknown) => void) | ((code: number) => void),
  ): void {
    if (event === "message") {
      this.messageListeners.add(listener as (value: unknown) => void);
    } else {
      this.exitListeners.add(listener as (code: number) => void);
    }
  }

  off(event: "message", listener: (value: unknown) => void): void;
  off(event: "exit", listener: (code: number) => void): void;
  off(
    event: "message" | "exit",
    listener: ((value: unknown) => void) | ((code: number) => void),
  ): void {
    if (event === "message") {
      this.messageListeners.delete(listener as (value: unknown) => void);
    } else {
      this.exitListeners.delete(listener as (code: number) => void);
    }
  }

  kill(): void {
    this.killed = true;
  }

  emitMessage(value: unknown): void {
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
    context: { conversationId: "c1", systemPrompt: "sys", messages: [] },
    options: { webSearch: false },
    apiKey: "sk-test-key",
    modelId: "deepseek-v4-flash",
  };
}

function completed(requestId: string): AgentWorkerEvent {
  return { requestId, type: "completed", text: "done" };
}

async function collect(stream: AsyncIterable<AgentWorkerEvent>): Promise<AgentWorkerEvent[]> {
  const values: AgentWorkerEvent[] = [];
  for await (const item of stream) {
    values.push(item);
  }
  return values;
}

describe("agent worker runtime", () => {
  it("adapts child messaging and streams events", async () => {
    const child = new FakeChild();
    const runtime = createAgentWorkerRuntime(child);
    const stream = runtime.client.send(request("req-1"));
    expect(child.posted).toEqual([request("req-1")]);
    child.emitMessage(completed("req-1"));
    expect(await collect(stream)).toEqual([completed("req-1")]);
    runtime.dispose();
  });

  it("dispose disposes the client and kills a live child", () => {
    const child = new FakeChild();
    const runtime = createAgentWorkerRuntime(child);
    expect(child.messageListenerCount()).toBe(1);
    expect(child.exitListenerCount()).toBe(2);
    runtime.dispose();
    expect(child.killed).toBe(true);
    expect(child.messageListenerCount()).toBe(0);
    expect(child.exitListenerCount()).toBe(0);
  });

  it("does not kill an already exited child on dispose", () => {
    const child = new FakeChild();
    const runtime = createAgentWorkerRuntime(child);
    child.emitExit(1);
    runtime.dispose();
    expect(child.killed).toBe(false);
    expect(child.exitListenerCount()).toBe(0);
  });
});
