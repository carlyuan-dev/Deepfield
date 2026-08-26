import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
} from "@deepfield/contracts";
import { createWorkerMessageLoop, type ChatAgent, type WorkerEndpoint } from "./message-loop.js";

class InMemoryEndpoint implements WorkerEndpoint {
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

function request(requestId = "req-1"): AgentWorkerRequest {
  return {
    requestId,
    kind: "chat.prompt",
    prompt: "你好",
    context: { projectId: "p1", conversationId: "c1", systemPrompt: "sys", messages: [] },
    apiKey: "sk-test-key",
    modelId: "deepseek-chat",
  };
}

const echoAgent: ChatAgent = {
  async run(workerRequest, emit) {
    emit({ requestId: workerRequest.requestId, type: "started" });
    emit({ requestId: workerRequest.requestId, type: "text_delta", delta: "你好" });
    emit({ requestId: workerRequest.requestId, type: "completed", text: "你好" });
  },
};

async function flushPending(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("worker message loop", () => {
  it("streams only schema-valid events for a valid request", async () => {
    const endpoint = new InMemoryEndpoint();
    createWorkerMessageLoop(endpoint, echoAgent);
    endpoint.emit(request());
    await flushPending();
    expect(endpoint.posted).toEqual([
      { requestId: "req-1", type: "started" },
      { requestId: "req-1", type: "text_delta", delta: "你好" },
      { requestId: "req-1", type: "completed", text: "你好" },
    ]);
    for (const value of endpoint.posted) {
      expect(Value.Check(AgentWorkerEventSchema, value)).toBe(true);
    }
  });

  it("replies failed invalid_request to malformed requests with a safe request id", () => {
    const endpoint = new InMemoryEndpoint();
    createWorkerMessageLoop(endpoint, echoAgent);
    endpoint.emit({
      requestId: "bad-1",
      kind: "chat.prompt",
      prompt: "super-secret-prompt",
      context: {
        projectId: "p1",
        conversationId: "c1",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "x" }],
      },
      apiKey: "sk-secret-api-key",
      modelId: "deepseek-chat",
    });
    expect(endpoint.posted).toHaveLength(1);
    const posted = endpoint.posted[0] as AgentWorkerEvent;
    expect(posted).toEqual({
      requestId: "bad-1",
      type: "failed",
      code: "invalid_request",
      message: "invalid agent worker request",
    });
    expect(JSON.stringify(posted)).not.toContain("super-secret-prompt");
    expect(JSON.stringify(posted)).not.toContain("sk-secret-api-key");
  });

  it("silently drops malformed requests without a safe request id", () => {
    const endpoint = new InMemoryEndpoint();
    createWorkerMessageLoop(endpoint, echoAgent);
    endpoint.emit({ kind: "chat.prompt" });
    expect(endpoint.posted).toEqual([]);
  });

  it("converts agent exceptions into a generic failed event", async () => {
    const endpoint = new InMemoryEndpoint();
    const failing: ChatAgent = {
      async run() {
        throw new Error("provider failed for prompt 你好 with sk-secret-api-key");
      },
    };
    createWorkerMessageLoop(endpoint, failing);
    endpoint.emit(request());
    await flushPending();
    expect(endpoint.posted).toEqual([
      {
        requestId: "req-1",
        type: "failed",
        code: "agent_error",
        message: "agent execution failed",
      },
    ]);
  });

  it("sanitizes invalid agent emits and ignores events for other streams", async () => {
    const endpoint = new InMemoryEndpoint();
    const badEmitter: ChatAgent = {
      async run(workerRequest, emit) {
        emit({ requestId: "other-request", type: "text_delta", delta: "cross" });
        emit({ requestId: workerRequest.requestId, type: "text_delta" } as unknown as AgentWorkerEvent);
      },
    };
    createWorkerMessageLoop(endpoint, badEmitter);
    endpoint.emit(request());
    await flushPending();
    expect(endpoint.posted).toEqual([
      {
        requestId: "req-1",
        type: "failed",
        code: "invalid_event",
        message: "agent emitted an invalid event",
      },
    ]);
  });

  it("production composition reports agent_not_configured via the unavailable agent", async () => {
    const endpoint = new InMemoryEndpoint();
    const unavailable: ChatAgent = {
      async run(workerRequest, emit) {
        emit({
          requestId: workerRequest.requestId,
          type: "failed",
          code: "agent_not_configured",
          message: "agent is not configured",
        });
      },
    };
    createWorkerMessageLoop(endpoint, unavailable);
    endpoint.emit(request());
    await flushPending();
    expect(endpoint.posted).toEqual([
      {
        requestId: "req-1",
        type: "failed",
        code: "agent_not_configured",
        message: "agent is not configured",
      },
    ]);
  });

  it("dispose removes the endpoint listener", () => {
    const endpoint = new InMemoryEndpoint();
    const loop = createWorkerMessageLoop(endpoint, echoAgent);
    expect(endpoint.listenerCount()).toBe(1);
    loop.dispose();
    expect(endpoint.listenerCount()).toBe(0);
    endpoint.emit(request());
    expect(endpoint.posted).toEqual([]);
  });

  it("emits agent_no_terminal_event when the agent resolves without a terminal event", async () => {
    const endpoint = new InMemoryEndpoint();
    const silentAgent: ChatAgent = {
      async run(workerRequest, emit) {
        emit({ requestId: workerRequest.requestId, type: "started" });
      },
    };
    const loop = createWorkerMessageLoop(endpoint, silentAgent);
    endpoint.emit(request());
    await flushPending();
    expect(endpoint.posted).toEqual([
      { requestId: "req-1", type: "started" },
      {
        requestId: "req-1",
        type: "failed",
        code: "agent_no_terminal_event",
        message: "agent finished without a terminal event",
      },
    ]);
    expect(loop.activeCount()).toBe(0);
  });

  it("settles with invalid_event when the agent emits without a request id", async () => {
    const endpoint = new InMemoryEndpoint();
    const badEmitter: ChatAgent = {
      async run(workerRequest, emit) {
        emit({ type: "text_delta", delta: "x" } as unknown as AgentWorkerEvent);
      },
    };
    const loop = createWorkerMessageLoop(endpoint, badEmitter);
    endpoint.emit(request());
    await flushPending();
    expect(endpoint.posted).toEqual([
      {
        requestId: "req-1",
        type: "failed",
        code: "invalid_event",
        message: "agent emitted an invalid event",
      },
    ]);
    expect(loop.activeCount()).toBe(0);
  });

  it("settles with invalid_event when the agent emits for another request id", async () => {
    const endpoint = new InMemoryEndpoint();
    const crossEmitter: ChatAgent = {
      async run(workerRequest, emit) {
        emit({ requestId: "other-request", type: "text_delta", delta: "cross" });
      },
    };
    const loop = createWorkerMessageLoop(endpoint, crossEmitter);
    endpoint.emit(request());
    await flushPending();
    expect(endpoint.posted).toEqual([
      {
        requestId: "req-1",
        type: "failed",
        code: "invalid_event",
        message: "agent emitted an invalid event",
      },
    ]);
    expect(loop.activeCount()).toBe(0);
  });

  it("dispose aborts active agents and drops all late activity", async () => {
    const endpoint = new InMemoryEndpoint();
    let capturedSignal: AbortSignal | undefined;
    const pendingAgent: ChatAgent = {
      async run(workerRequest, emit, signal) {
        capturedSignal = signal;
        emit({ requestId: workerRequest.requestId, type: "started" });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
        emit({ requestId: workerRequest.requestId, type: "completed", text: "late" });
        throw new Error("late failure");
      },
    };
    const loop = createWorkerMessageLoop(endpoint, pendingAgent);
    endpoint.emit(request());
    await flushPending();
    expect(endpoint.posted).toEqual([{ requestId: "req-1", type: "started" }]);
    expect(loop.activeCount()).toBe(1);

    loop.dispose();
    expect(capturedSignal?.aborted).toBe(true);
    await flushPending();
    expect(endpoint.posted).toEqual([{ requestId: "req-1", type: "started" }]);
    expect(loop.activeCount()).toBe(0);
  });

  it("rejects a second request for the same active request id", async () => {
    const endpoint = new InMemoryEndpoint();
    let runCount = 0;
    const pendingAgent: ChatAgent = {
      async run(workerRequest, emit, signal) {
        runCount += 1;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve());
        });
      },
    };
    const loop = createWorkerMessageLoop(endpoint, pendingAgent);
    endpoint.emit(request("req-1"));
    await flushPending();
    endpoint.emit(request("req-1"));
    await flushPending();
    expect(runCount).toBe(1);
    expect(endpoint.posted).toEqual([
      {
        requestId: "req-1",
        type: "failed",
        code: "duplicate_request",
        message: "a request with this id is already active",
      },
    ]);
    expect(loop.activeCount()).toBe(1);
    loop.dispose();
  });
});
