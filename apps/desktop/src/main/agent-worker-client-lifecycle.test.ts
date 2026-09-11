import { describe, expect, it } from "vitest";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import {
  AgentWorkerClient,
  AgentWorkerExitedError,
} from "./agent-worker-client.js";
import {
  collect,
  collectError,
  event,
  FakeEndpoint,
  request,
} from "./agent-worker-client-test-helpers.js";

describe("agent worker client lifecycle", () => {
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

  it("enters a permanent closed state after exit", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const stream = client.send(request("req-1"));
    endpoint.emitExit(3);

    const result = await collectError(stream);
    expect(result.error).toBeInstanceOf(AgentWorkerExitedError);
    expect(endpoint.messageListenerCount()).toBe(0);
    expect(endpoint.exitListenerCount()).toBe(0);

    const postedBefore = endpoint.posted.length;
    const second = request("req-2");
    expect(() =>
      client.send({ ...second, prompt: "super-secret-prompt", llm: { ...second.llm, apiKey: "sk-secret-api-key" } }),
    ).toThrow(AgentWorkerExitedError);
    expect(endpoint.posted.length).toBe(postedBefore);

    try {
      const third = request("req-3");
      client.send({ ...third, prompt: "super-secret-prompt", llm: { ...third.llm, apiKey: "sk-secret-api-key" } });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("super-secret-prompt");
      expect(message).not.toContain("sk-secret-api-key");
      expect(message).not.toContain("req-3");
    }
  });

  it("still rejects sends after dispose", () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    client.dispose();
    expect(() => client.send(request("req-1"))).toThrow(/disposed/);
  });

  it("removes the pending entry as soon as the terminal event is queued", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const stream = client.send(request("req-1"));
    endpoint.emit(event("req-1", "text_delta", "A"));
    endpoint.emit(event("req-1", "completed", "A"));
    expect(client.pendingCount()).toBe(0);
    expect(await collect(stream)).toEqual(["A", "completed:A"]);
    const again = client.send(request("req-1"));
    endpoint.emit(event("req-1", "completed", "B"));
    expect(await collect(again)).toEqual(["completed:B"]);
  });

  it("removes the pending entry when the terminal event wakes a waiter", async () => {
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const stream = client.send(request("req-1"));
    const collected = collect(stream);
    endpoint.emit(event("req-1", "completed", "done"));
    expect(client.pendingCount()).toBe(0);
    expect(await collected).toEqual(["completed:done"]);
  });
});
