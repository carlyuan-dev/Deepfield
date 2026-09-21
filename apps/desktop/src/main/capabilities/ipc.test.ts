import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { CapabilityRegistry, activateRegisteredCapability } from "./registry.js";
import { AgentWorkerClient } from "../agent-worker-client.js";
import { FakeEndpoint } from "../agent-worker-client-test-helpers.js";
import { flushPending } from "../../worker/message-loop-test-helpers.js";

describe("capability registry", () => {
  it.each(["failed", "timeout", "exit"] as const)("rolls back Main when Worker activation %s", async mode => {
    const registry = new CapabilityRegistry(); const endpoint = new FakeEndpoint(); const client = new AgentWorkerClient(endpoint);
    const cleanup = vi.fn(); const start = vi.fn();
    const activation = activateRegisteredCapability({ registry, capabilityId: "example", activateMain: registrar => { registrar.defer(cleanup); registrar.onReady(start); }, activateWorker: () => client.activateCapability("example", "/trusted/worker.js", "activate", 10), onWorkerUnavailable: listener => client.subscribeUnavailable(listener) });
    const rejected = expect(activation).rejects.toThrow();
    await flushPending();
    if (mode === "failed") endpoint.emit({ kind: "capability.activated", requestId: "activate", capabilityId: "example", ok: false });
    if (mode === "exit") endpoint.emitExit(1);
    await rejected;
    expect(cleanup).toHaveBeenCalledTimes(1); expect(start).not.toHaveBeenCalled(); expect(registry.readyIds()).toEqual([]);
    client.dispose();
  });
  it("removes ready immediately on Worker exit and prevents late ready hooks publishing", async () => {
    const registry = new CapabilityRegistry(); const endpoint = new FakeEndpoint(); const client = new AgentWorkerClient(endpoint);
    const cleanup = vi.fn();
    const activation = await activateRegisteredCapability({ registry, capabilityId: "example", activateMain: registrar => registrar.defer(cleanup), activateWorker: async () => {}, onWorkerUnavailable: listener => client.subscribeUnavailable(listener) });
    expect(registry.readyIds()).toEqual(["example"]);
    endpoint.emitExit(1); await activation.dispose();
    expect(registry.readyIds()).toEqual([]); expect(cleanup).toHaveBeenCalledTimes(1);
    const pending = registry.begin("pending"); let release!: () => void; const lateCleanup = vi.fn();
    pending.onReady(async () => { await new Promise<void>(resolve => { release = resolve; }); pending.defer(lateCleanup); });
    const ready = pending.ready(); const rejected = expect(ready).rejects.toThrow();
    await pending.dispose(); release(); await rejected; await flushPending();
    expect(registry.readyIds()).toEqual([]); expect(lateCleanup).toHaveBeenCalledTimes(1);
  });
  it("rejects empty, disabled and unready registrations", async () => {
    const registry = new CapabilityRegistry();
    const call = { capabilityId: "test", operation: "echo", requestId: "r", input: ["ok"] };
    await expect(registry.call(call)).rejects.toMatchObject({ code: "capability_unavailable" });
    const activation = registry.begin("test");
    activation.register("echo", Type.Tuple([Type.String()]), Type.String(), ([value]) => value);
    await expect(registry.call(call)).rejects.toMatchObject({ code: "capability_unavailable" });
    await activation.ready();
    expect(await registry.call(call)).toBe("ok");
    await activation.dispose();
    await expect(registry.call(call)).rejects.toMatchObject({ code: "capability_unavailable" });
  });
  it("validates payloads and drops events after rollback", async () => {
    const registry = new CapabilityRegistry();
    const activation = registry.begin("test");
    const cleanup = vi.fn();
    activation.defer(cleanup);
    activation.register("echo", Type.Tuple([Type.String()]), Type.String(), ([value]) => value);
    activation.registerTopic("updates", Type.String());
    const listener = vi.fn();
    registry.subscribe(listener);
    await activation.ready();
    expect(() => activation.emit("foreign", "x")).toThrow();
    activation.emit("updates", "x");
    expect(listener).toHaveBeenCalledWith({ capabilityId: "test", topic: "updates", payload: "x" });
    await expect(registry.call({ capabilityId: "test", operation: "echo", requestId: "r", input: [1] })).rejects.toThrow();
    await activation.dispose();
    await activation.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(registry.readyIds()).toEqual([]);
  });
});
