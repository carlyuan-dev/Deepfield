import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  CompanyResearchWorkerEventSchema,
  ToolEventEnvelopeSchema,
  type AgentWorkerEvent,
  type CompanyResearchWorkerEvent,
  type ToolExecutionEvent,
} from "@deepfield/contracts";
import { createWorkerMessageLoop, type ChatAgent, type ToolRuntime } from "./message-loop.js";
import { rawResearchRequest, structureResearchRequest } from "./capabilities/company-research/company-research-test-helpers.js";
import {
  echoAgent,
  echoToolRuntime,
  flushPending,
  InMemoryEndpoint,
  request,
  toolEvent,
  toolRunRequest,
} from "./message-loop-test-helpers.js";

describe("worker message loop", () => {
  it.each([rawResearchRequest(), structureResearchRequest()])("correlates stage on $stage failure without leaking errors", async (req) => {
    const endpoint = new InMemoryEndpoint();
    const loop = createWorkerMessageLoop(endpoint, echoAgent, {
      researchAgent: { async run() { throw new Error("secret provider error"); } },
    });
    endpoint.emit(req);
    await flushPending();
    expect(endpoint.posted).toEqual([{
      requestId: req.requestId, runId: req.runId, stage: req.stage, type: "failed",
      code: req.stage === "raw" ? "research_failed" : "structuring_failed",
      message: req.stage === "raw" ? "company research failed" : "company research structuring failed",
    }]);
    expect(Value.Check(CompanyResearchWorkerEventSchema, endpoint.posted[0])).toBe(true);
    expect(loop.activeCount()).toBe(0);
    loop.dispose();
  });

  it("rejects a wrong-stage terminal and suppresses all later events", async () => {
    const endpoint = new InMemoryEndpoint();
    let aborted = false;
    const loop = createWorkerMessageLoop(endpoint, echoAgent, {
      researchAgent: { async run(req, emit, signal) {
        signal.addEventListener("abort", () => { aborted = true; });
        emit({ requestId: req.requestId, runId: req.runId, stage: "raw", type: "completed", text: "wrong" });
        emit({ requestId: req.requestId, runId: req.runId, stage: "structure", type: "completed", text: "late" });
      } },
    });
    endpoint.emit(structureResearchRequest());
    await flushPending();
    expect(endpoint.posted).toHaveLength(1);
    expect(endpoint.posted[0]).toMatchObject({ type: "failed", stage: "structure", code: "structuring_failed" });
    expect(aborted).toBe(true);
    expect(loop.activeCount()).toBe(0);
    loop.dispose();
  });

  it("classifies an invalid raw research event as protocol_error and suppresses later events", async () => {
    const endpoint = new InMemoryEndpoint();
    let aborted = false;
    const loop = createWorkerMessageLoop(endpoint, echoAgent, {
      researchAgent: { async run(req, emit, signal) {
        signal.addEventListener("abort", () => { aborted = true; });
        emit({
          requestId: req.requestId,
          runId: req.runId,
          stage: "raw",
          type: "tool_activity",
          callKey: "search-1",
          name: "web_search",
          status: "completed",
          queryOrUrl: "chat-only metadata",
        } as unknown as CompanyResearchWorkerEvent);
        emit({ requestId: req.requestId, runId: req.runId, stage: "raw", type: "completed", text: "late" });
      } },
    });

    endpoint.emit(rawResearchRequest());
    await flushPending();

    expect(endpoint.posted).toEqual([{
      requestId: rawResearchRequest().requestId,
      runId: rawResearchRequest().runId,
      stage: "raw",
      type: "failed",
      code: "protocol_error",
      message: "company research failed",
    }]);
    expect(aborted).toBe(true);
    expect(loop.activeCount()).toBe(0);
    loop.dispose();
  });

  it.each([rawResearchRequest(), structureResearchRequest()])("cancels $stage only on all three identity fields and settles an uncooperative agent", async (req) => {
    const endpoint = new InMemoryEndpoint();
    let signal: AbortSignal | undefined;
    const loop = createWorkerMessageLoop(endpoint, echoAgent, {
      researchAgent: { async run(_req, _emit, currentSignal) { signal = currentSignal; await new Promise(() => {}); } },
    });
    endpoint.emit(req);
    await flushPending();
    const cancel = { requestId: req.requestId, runId: req.runId, stage: req.stage, kind: "company-research.cancel" };
    endpoint.emit({ ...cancel, stage: req.stage === "raw" ? "structure" : "raw" });
    endpoint.emit({ ...cancel, runId: "other-run" });
    endpoint.emit({ ...cancel, requestId: "other-request" });
    expect(signal?.aborted).toBe(false);
    endpoint.emit(cancel);
    endpoint.emit(cancel);
    expect(signal?.aborted).toBe(true);
    expect(endpoint.posted).toEqual([{ requestId: req.requestId, runId: req.runId, stage: req.stage, type: "cancelled" }]);
    expect(loop.activeCount()).toBe(0);
    loop.dispose();
  });

  it("fails with the structure identity when no research agent is available", () => {
    const endpoint = new InMemoryEndpoint();
    const loop = createWorkerMessageLoop(endpoint, echoAgent);
    endpoint.emit(structureResearchRequest());
    expect(endpoint.posted[0]).toMatchObject({ stage: "structure", type: "failed", code: "structuring_failed" });
    loop.dispose();
  });
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
      modelId: "deepseek-flash",
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

describe("worker message loop tool.run (envelopes)", () => {
  it("routes tool.run to the tool runtime and forwards enveloped events", async () => {
    const endpoint = new InMemoryEndpoint();
    const loop = createWorkerMessageLoop(endpoint, echoAgent, { toolRuntime: echoToolRuntime });
    expect(endpoint.listenerCount()).toBe(1);
    endpoint.emit(toolRunRequest("exec-1"));
    await flushPending();
    expect(
      endpoint.posted.map((value) => [
        (value as { requestId: string }).requestId,
        (value as { event: { type: string } }).event.type,
      ]),
    ).toEqual([
      ["exec-1", "started"],
      ["exec-1", "completed"],
    ]);
    for (const value of endpoint.posted) {
      expect(Value.Check(ToolEventEnvelopeSchema, value)).toBe(true);
    }
    expect(loop.activeCount()).toBe(0);
  });

  it("keeps chat and tool runs isolated with one active map", async () => {
    const endpoint = new InMemoryEndpoint();
    const loop = createWorkerMessageLoop(endpoint, echoAgent, { toolRuntime: echoToolRuntime });
    endpoint.emit(request("chat-1"));
    endpoint.emit(toolRunRequest("exec-1"));
    await flushPending();
    const chatTypes = endpoint.posted
      .filter((value) => (value as { requestId?: string }).requestId === "chat-1")
      .map((value) => (value as { type: string }).type);
    expect(chatTypes).toEqual(["started", "text_delta", "completed"]);
    const toolEnvelopes = endpoint.posted.filter(
      (value) => (value as { kind?: string }).kind === "tool.event",
    );
    expect(toolEnvelopes.map((value) => (value as { event: { type: string } }).event.type)).toEqual([
      "started",
      "completed",
    ]);
    expect(loop.activeCount()).toBe(0);
  });

  it("rejects a second tool.run with the same executionId without executing it", async () => {
    const endpoint = new InMemoryEndpoint();
    let calls = 0;
    const counting: ToolRuntime = {
      async run(request, emit) {
        calls += 1;
        emit(toolEvent(request.executionId, request.traceId, "started"));
        emit(toolEvent(request.executionId, request.traceId, "completed"));
      },
    };
    const loop = createWorkerMessageLoop(endpoint, echoAgent, { toolRuntime: counting });
    endpoint.emit(toolRunRequest("exec-1"));
    endpoint.emit(toolRunRequest("exec-1", "trace-1", "r2"));
    await flushPending();
    expect(calls).toBe(1);
    const envelopes = endpoint.posted.filter(
      (value) => (value as { kind?: string }).kind === "tool.event",
    ) as Array<{ event: { failure?: { code: string } } }>;
    expect(envelopes.map((value) => value.event.failure?.code)).toContain("duplicate_execution");
    expect(loop.activeCount()).toBe(0);
  });

  it("terminates the active flow on duplicate transport ids across kinds", async () => {
    const endpoint = new InMemoryEndpoint();
    let release!: () => void;
    const gated: ChatAgent = {
      async run(workerRequest, emit) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        emit({ requestId: workerRequest.requestId, type: "completed", text: "late" });
      },
    };
    const loop = createWorkerMessageLoop(endpoint, gated, { toolRuntime: echoToolRuntime });
    endpoint.emit(request("dup-1"));
    await flushPending();
    endpoint.emit(toolRunRequest("exec-1", "trace-1", "dup-1"));
    await flushPending();
    expect(
      endpoint.posted.some(
        (value) =>
          (value as { type?: string }).type === "failed" &&
          (value as { code?: string }).code === "duplicate_request",
      ),
    ).toBe(true);
    release();
    await flushPending();
    expect(loop.activeCount()).toBe(0);
  });

  it("settles an invalid tool event with a single safe failed envelope", async () => {
    const endpoint = new InMemoryEndpoint();
    const badRuntime: ToolRuntime = {
      async run(_request, emit) {
        emit({
          executionId: "wrong",
          traceId: "trace-1",
          tool: { name: "echo", version: 1 },
          sequence: 0,
          timestamp: 0,
          type: "started",
        } as ToolExecutionEvent);
      },
    };
    const loop = createWorkerMessageLoop(endpoint, echoAgent, { toolRuntime: badRuntime });
    endpoint.emit(toolRunRequest("exec-1"));
    await flushPending();
    const envelopes = endpoint.posted.filter(
      (value) => (value as { kind?: string }).kind === "tool.event",
    ) as Array<{ event: { type: string; failure?: { code: string } } }>;
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.event.type).toBe("failed");
    expect(envelopes[0]!.event.failure?.code).toBe("invalid_event");
    expect(loop.activeCount()).toBe(0);
  });

  it("aborts tool executions on dispose", async () => {
    const endpoint = new InMemoryEndpoint();
    let aborted = false;
    const hangingTool: ToolRuntime = {
      async run(_request, _emit, signal) {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        await new Promise(() => {});
      },
    };
    const loop = createWorkerMessageLoop(endpoint, echoAgent, { toolRuntime: hangingTool });
    endpoint.emit(toolRunRequest("exec-1"));
    await flushPending();
    expect(loop.activeCount()).toBe(1);
    loop.dispose();
    expect(aborted).toBe(true);
    expect(loop.activeCount()).toBe(0);
  });
});
