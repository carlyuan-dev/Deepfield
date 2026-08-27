import { describe, expect, it } from "vitest";
import {
  AgentProtocolError,
  AgentWorkerClient,
  AgentWorkerExitedError,
  AgentWorkerQueueOverflowError,
} from "./agent-worker-client.js";
import {
  collect,
  collectError,
  collectTool,
  collectToolError,
  collectUntilDelta,
  event,
  FakeEndpoint,
  request,
  toolEnvelope,
  toolEvent,
  toolRequest,
} from "./agent-worker-client-test-helpers.js";

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
});

describe("agent worker client tool streams (envelopes)", () => {
  it("posts tool.run and delivers enveloped tool events with a single listener", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    expect(endpoint.messageListenerCount()).toBe(1);
    const req = toolRequest("exec-1");
    const stream = client.sendTool(req);
    endpoint.emit(toolEnvelope("exec-1", "exec-1", "trace-1", "started"));
    endpoint.emit(toolEnvelope("exec-1", "exec-1", "trace-1", "completed"));
    expect(endpoint.posted).toEqual([req]);
    expect(await collectTool(stream)).toEqual(["started", "completed"]);
    expect(client.pendingCount()).toBe(0);
  });

  it("keeps chat and tool streams interleaved without cross-talk", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const chat = client.send(request("req-1"));
    const tool = client.sendTool(toolRequest("exec-1"));
    endpoint.emit(event("req-1", "text_delta", "C"));
    endpoint.emit(toolEnvelope("exec-1", "exec-1", "trace-1", "started"));
    endpoint.emit(toolEnvelope("exec-1", "exec-1", "trace-1", "completed"));
    endpoint.emit(event("req-1", "completed", "C"));
    expect(await collectTool(tool)).toEqual(["started", "completed"]);
    expect(await collect(chat)).toEqual(["C", "completed:C"]);
  });

  it("closes only the matching stream when its own envelope carries a wrong nested id", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const first = client.sendTool(toolRequest("exec-1", "trace-shared"));
    const second = client.sendTool(toolRequest("exec-2", "trace-shared", "exec-2"));
    // envelope for first's transport id but wrong nested executionId -> close first only
    endpoint.emit(toolEnvelope("exec-1", "wrong-nested", "trace-shared", "started"));
    expect((await collectToolError(first)).error).toBeInstanceOf(AgentProtocolError);
    expect(client.pendingCount()).toBe(1);
    // wrong nested traceId on second's own envelope -> close second only
    endpoint.emit(toolEnvelope("exec-2", "exec-2", "wrong-trace", "started"));
    expect((await collectToolError(second)).error).toBeInstanceOf(AgentProtocolError);
    expect(client.pendingCount()).toBe(0);
  });

  it("ignores envelopes for unknown transport ids without touching live streams", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const first = client.sendTool(toolRequest("exec-1", "trace-shared"));
    const second = client.sendTool(toolRequest("exec-2", "trace-shared", "exec-2"));
    endpoint.emit(toolEnvelope("ghost", "ghost-exec", "trace-shared", "started"));
    expect(client.pendingCount()).toBe(2);
    endpoint.emit(toolEnvelope("exec-1", "exec-1", "trace-shared", "started"));
    endpoint.emit(toolEnvelope("exec-1", "exec-1", "trace-shared", "completed"));
    endpoint.emit(toolEnvelope("exec-2", "exec-2", "trace-shared", "started"));
    endpoint.emit(toolEnvelope("exec-2", "exec-2", "trace-shared", "completed"));
    expect(await collectTool(first)).toEqual(["started", "completed"]);
    expect(await collectTool(second)).toEqual(["started", "completed"]);
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects duplicate ids across chat and tool streams", () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    client.send(request("shared"));
    expect(() => client.sendTool(toolRequest("shared"))).toThrow(/duplicate/);
  });

  it("rejects duplicate transport ids while pending", () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    client.sendTool(toolRequest("exec-1"));
    expect(() => client.sendTool(toolRequest("exec-9", "trace-9", "exec-1"))).toThrow(/duplicate/);
  });

  it("cleans pending on terminal, tombstones the transport id, and drops late old envelopes", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const first = client.sendTool(toolRequest("exec-1"));
    endpoint.emit(toolEnvelope("exec-1", "exec-1", "trace-1", "completed"));
    expect(client.pendingCount()).toBe(0);
    // late envelope from the old generation is dropped
    endpoint.emit(toolEnvelope("exec-1", "exec-1", "trace-1", "started"));
    // transport id is tombstoned: immediate reuse is refused
    expect(() => client.sendTool(toolRequest("exec-1"))).toThrow(/already used/);
    // a fresh transport id with the same executionId works
    const second = client.sendTool(toolRequest("exec-1", "trace-1", "exec-1-v2"));
    endpoint.emit(toolEnvelope("exec-1-v2", "exec-1", "trace-1", "started"));
    endpoint.emit(toolEnvelope("exec-1-v2", "exec-1", "trace-1", "completed"));
    expect(await collectTool(first)).toEqual(["completed"]);
    expect(await collectTool(second)).toEqual(["started", "completed"]);
  });

  it("closes an unconsumed tool queue on overflow", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const stream = client.sendTool(toolRequest("exec-1"));
    for (let index = 0; index <= 1000; index += 1) {
      endpoint.emit(toolEnvelope("exec-1", "exec-1", "trace-1", "progress"));
    }
    const result = await collectToolError(stream);
    expect(result.error).toBeInstanceOf(AgentWorkerQueueOverflowError);
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects sendTool after dispose and settles tool streams on exit", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const stream = client.sendTool(toolRequest("exec-1"));
    endpoint.emitExit(1);
    expect((await collectToolError(stream)).error).toBeInstanceOf(AgentWorkerExitedError);
    expect(() => client.sendTool(toolRequest("exec-2"))).toThrow();
    const disposed = new AgentWorkerClient(new FakeEndpoint());
    disposed.dispose();
    expect(() => disposed.sendTool(toolRequest("exec-1"))).toThrow(/disposed/);
  });

  it("tombstones the transport id on protocol-error close and queue overflow, keeping live streams safe", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    // wrong nested id closes the stream with a protocol error
    const closed = client.sendTool(toolRequest("exec-1"));
    endpoint.emit(toolEnvelope("exec-1", "wrong-nested", "trace-1", "started"));
    expect((await collectToolError(closed)).error).toBeInstanceOf(AgentProtocolError);
    expect(() => client.sendTool(toolRequest("exec-1"))).toThrow(/already used/);
    // queue overflow closes the stream; its transport id is also tombstoned
    const overflow = client.sendTool(toolRequest("exec-2", "trace-2", "exec-2"));
    for (let index = 0; index <= 1000; index += 1) {
      endpoint.emit(toolEnvelope("exec-2", "exec-2", "trace-2", "progress"));
    }
    expect((await collectToolError(overflow)).error).toBeInstanceOf(AgentWorkerQueueOverflowError);
    expect(() => client.sendTool(toolRequest("exec-9", "trace-9", "exec-2"))).toThrow(
      /already used/,
    );
    // a late envelope from a closed generation never affects a live stream
    const live = client.sendTool(toolRequest("exec-3", "trace-3", "exec-3"));
    endpoint.emit(toolEnvelope("exec-1", "exec-1", "trace-1", "started"));
    endpoint.emit(toolEnvelope("exec-3", "exec-3", "trace-3", "started"));
    endpoint.emit(toolEnvelope("exec-3", "exec-3", "trace-3", "completed"));
    expect(await collectTool(live)).toEqual(["started", "completed"]);
    expect(client.pendingCount()).toBe(0);
  });
});
