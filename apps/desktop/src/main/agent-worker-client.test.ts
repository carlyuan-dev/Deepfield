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

describe("agent worker client tool streams", () => {
  it("posts tool.run and delivers tool events with a single listener", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    expect(endpoint.messageListenerCount()).toBe(1);
    const req = toolRequest("exec-1");
    const stream = client.sendTool(req);
    endpoint.emit(toolEvent("exec-1", "trace-1", "started"));
    endpoint.emit(toolEvent("exec-1", "trace-1", "completed"));
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
    endpoint.emit(toolEvent("exec-1", "trace-1", "started"));
    endpoint.emit(toolEvent("exec-1", "trace-1", "completed"));
    endpoint.emit(event("req-1", "completed", "C"));
    expect(await collectTool(tool)).toEqual(["started", "completed"]);
    expect(await collect(chat)).toEqual(["C", "completed:C"]);
  });

  it("closes the tool stream on wrong executionId or traceId", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const wrongExecution = client.sendTool(toolRequest("exec-1"));
    endpoint.emit(toolEvent("wrong", "trace-1", "started"));
    expect((await collectToolError(wrongExecution)).error).toBeInstanceOf(AgentProtocolError);
    expect(client.pendingCount()).toBe(0);
    const wrongTrace = client.sendTool(toolRequest("exec-2", "trace-2"));
    endpoint.emit(toolEvent("exec-2", "wrong-trace", "started"));
    expect((await collectToolError(wrongTrace)).error).toBeInstanceOf(AgentProtocolError);
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects duplicate ids across chat and tool streams", () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    client.send(request("shared"));
    expect(() => client.sendTool(toolRequest("shared"))).toThrow(/duplicate/);
  });

  it("rejects duplicate tool execution ids while pending", () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    client.sendTool(toolRequest("exec-1"));
    expect(() => client.sendTool(toolRequest("exec-1"))).toThrow(/duplicate/);
  });

  it("cleans tool pending immediately on terminal and allows id reuse, dropping late events", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const first = client.sendTool(toolRequest("exec-1"));
    endpoint.emit(toolEvent("exec-1", "trace-1", "completed"));
    expect(client.pendingCount()).toBe(0);
    endpoint.emit(toolEvent("exec-1", "trace-1", "started"));
    const second = client.sendTool(toolRequest("exec-1"));
    endpoint.emit(toolEvent("exec-1", "trace-1", "started"));
    endpoint.emit(toolEvent("exec-1", "trace-1", "completed"));
    expect(await collectTool(first)).toEqual(["completed"]);
    expect(await collectTool(second)).toEqual(["started", "completed"]);
  });

  it("closes an unconsumed tool queue on overflow", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const stream = client.sendTool(toolRequest("exec-1"));
    for (let index = 0; index <= 1000; index += 1) {
      endpoint.emit(toolEvent("exec-1", "trace-1", "progress"));
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
});
