import { describe, expect, it } from "vitest";
import {
  AgentProtocolError,
  AgentWorkerClient,
  AgentWorkerQueueOverflowError,
} from "./agent-worker-client.js";
import {
  collect,
  collectError,
  collectUntilDelta,
  event,
  FakeEndpoint,
  request,
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
