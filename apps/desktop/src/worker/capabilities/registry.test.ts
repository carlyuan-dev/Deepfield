import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { WorkerCapabilityRegistry } from "./registry.js";
import { createWorkerMessageLoop } from "../message-loop.js";
import { echoAgent, InMemoryEndpoint, flushPending, request } from "../message-loop-test-helpers.js";

const call = { kind: "capability.run", capabilityId: "example", operation: "echo", requestId: "r", input: "x" };
describe("Worker capability registry", () => {
  it("keeps Chat available with an empty registry and safely rejects unknown packages", async () => {
    const endpoint = new InMemoryEndpoint();
    const registry = new WorkerCapabilityRegistry(event => endpoint.postMessage(event));
    const loop = createWorkerMessageLoop(endpoint, echoAgent, { capabilities: registry });
    endpoint.emit(call); endpoint.emit(request("chat"));
    await flushPending();
    expect(endpoint.posted[0]).toMatchObject({ kind: "capability.event", type: "failed", payload: { code: "capability_unavailable" } });
    expect(endpoint.posted.at(-1)).toMatchObject({ requestId: "chat", type: "completed" });
    loop.dispose();
  });
  it("validates payloads, scopes cancellation, settles once and drops late events", async () => {
    const post = vi.fn();
    const registry = new WorkerCapabilityRegistry(post);
    const activation = registry.begin("example");
    let aborted = false;
    activation.register("echo", Type.String(), Type.String(), async (input, emit, signal) => {
      emit(input);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }));
      emit("late", "completed");
    });
    activation.ready();
    registry.handle({ ...call, requestId: "invalid", input: 42 });
    await flushPending();
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ requestId: "invalid", type: "failed" });
    registry.handle(call); await flushPending();
    registry.handle({ kind: "capability.cancel", capabilityId: "other", operation: "echo", requestId: "r" });
    expect(aborted).toBe(false);
    const cancel = { kind: "capability.cancel", capabilityId: "example", operation: "echo", requestId: "r" };
    registry.handle(cancel); registry.handle(cancel); await flushPending();
    expect(aborted).toBe(true);
    expect(post.mock.calls.filter(([event]) => event.requestId === "r").map(([event]) => event.type)).toEqual(["progress", "cancelled"]);
    expect(registry.activeCount()).toBe(0);
    await registry.dispose();
  });
  it("rolls back partial Worker activation, including late resource allocation after shutdown", async () => {
    const cleanup = vi.fn(); const lateCleanup = vi.fn(); const post = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const registry = new WorkerCapabilityRegistry(post, async (_request, registrar) => {
      registrar.defer(cleanup); await gate; registrar.defer(lateCleanup);
    });
    registry.handle({ kind: "capability.activate", capabilityId: "example", requestId: "activate", entry: "/trusted/worker.js" });
    await registry.dispose(); release(); await flushPending();
    expect(cleanup).toHaveBeenCalledTimes(1); expect(lateCleanup).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
  it("shutdown aborts work without emitting a user-cancel terminal", async () => {
    const post = vi.fn(); const registry = new WorkerCapabilityRegistry(post);
    const activation = registry.begin("example");
    activation.register("echo", Type.String(), Type.String(), async (_input, emit, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { emit("cancel", "cancelled"); resolve(); }));
    });
    activation.ready(); registry.handle(call); await flushPending(); registry.abortAll(); await flushPending();
    expect(post).not.toHaveBeenCalled(); await registry.dispose();
  });
  it("correlates rollback to activation requestId so a late old cancellation cannot unload a replacement", async () => {
    const cleanup = vi.fn(); const post = vi.fn();
    const registry = new WorkerCapabilityRegistry(post, async (_request, registrar) => { registrar.defer(cleanup); registrar.register("echo", Type.String(), Type.String(), async (input, emit) => emit(input, "completed")); });
    registry.handle({ kind: "capability.activate", capabilityId: "example", requestId: "old", entry: "/trusted/worker.js" }); await flushPending();
    registry.handle({ kind: "capability.deactivate", capabilityId: "example", requestId: "old" }); await flushPending();
    registry.handle({ kind: "capability.activate", capabilityId: "example", requestId: "new", entry: "/trusted/worker.js" }); await flushPending();
    registry.handle({ kind: "capability.deactivate", capabilityId: "example", requestId: "old" });
    registry.handle(call); await flushPending();
    expect(cleanup).toHaveBeenCalledTimes(1); expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ type: "completed", payload: "x" });
    await registry.dispose();
  });
});
