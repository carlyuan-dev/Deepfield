import { describe, expect, it } from "vitest";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import { createWorkerMessageLoop, type ChatAgent } from "./message-loop.js";
import {
  flushPending,
  InMemoryEndpoint,
  request,
} from "./message-loop-test-helpers.js";

describe("worker message loop lifecycle", () => {
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

  it("settles and aborts the original execution when a duplicate request arrives", async () => {
    const endpoint = new InMemoryEndpoint();
    let runCount = 0;
    let capturedSignal: AbortSignal | undefined;
    const pendingAgent: ChatAgent = {
      async run(workerRequest, emit, signal) {
        runCount += 1;
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
    endpoint.emit(request("req-1"));
    await flushPending();
    expect(endpoint.posted).toEqual([{ requestId: "req-1", type: "started" }]);
    expect(loop.activeCount()).toBe(1);

    endpoint.emit(request("req-1"));
    await flushPending();

    expect(runCount).toBe(1);
    expect(capturedSignal?.aborted).toBe(true);
    expect(loop.activeCount()).toBe(0);
    expect(endpoint.posted).toEqual([
      { requestId: "req-1", type: "started" },
      {
        requestId: "req-1",
        type: "failed",
        code: "duplicate_request",
        message: "a request with this id is already active",
      },
    ]);
  });

  it("aborts the controller when an invalid emit settles the request", async () => {
    const endpoint = new InMemoryEndpoint();
    let capturedSignal: AbortSignal | undefined;
    const badEmitter: ChatAgent = {
      async run(workerRequest, emit, signal) {
        capturedSignal = signal;
        emit({ requestId: workerRequest.requestId, type: "text_delta" } as unknown as AgentWorkerEvent);
        emit({ requestId: workerRequest.requestId, type: "completed", text: "late" });
      },
    };
    const loop = createWorkerMessageLoop(endpoint, badEmitter);
    endpoint.emit(request());
    await flushPending();
    expect(capturedSignal?.aborted).toBe(true);
    expect(loop.activeCount()).toBe(0);
    expect(endpoint.posted).toEqual([
      {
        requestId: "req-1",
        type: "failed",
        code: "invalid_event",
        message: "agent emitted an invalid event",
      },
    ]);
  });
});
