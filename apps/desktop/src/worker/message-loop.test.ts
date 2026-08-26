import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { AgentWorkerEventSchema, type AgentWorkerEvent } from "@deepfield/contracts";
import { createWorkerMessageLoop, type ChatAgent } from "./message-loop.js";
import {
  echoAgent,
  flushPending,
  InMemoryEndpoint,
  request,
} from "./message-loop-test-helpers.js";

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

  it("settles with invalid_event when an agent emits malformed events", async () => {
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
});
