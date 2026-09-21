import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { createCapabilityHostServices, type CapabilityRegistrar } from "@deepfield/capability-sdk";
import { prepareCapabilities, createCapabilityRuntime } from "./runtime.js";
import { CapabilityRegistry } from "./registry.js";
import { writeEnabledIds } from "./preferences.js";
import { writeTestPackage } from "./startup-test-helpers.js";
import { createSnapshotWorkerLoader } from "../../shared/capability-entry.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(requirements: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "capability-runtime-test-")); roots.push(root);
  const paths = { scanRoot: join(root, "installed"), bundledRoot: join(root, "bundled"), statePath: join(root, "state.json") };
  await writeTestPackage(paths.bundledRoot, "test-package", requirements);
  return { paths, prepared: await prepareCapabilities(paths) };
}
function worker() {
  const exits = new Set<() => void>();
  return { activateCapability: vi.fn(async () => {}), deactivateCapability: vi.fn(),
    subscribeUnavailable: (listener: () => void) => { exits.add(listener); return () => { exits.delete(listener); }; },
    exit: () => { for (const listener of [...exits]) listener(); },
  };
}
const services = createCapabilityHostServices({});
describe("optional capability startup", () => {
  it("starts only after Worker ack, keeps active work on toggle, revokes navigation on exit and recreates from same snapshot", async () => {
    const { prepared } = await fixture(); const registry = new CapabilityRegistry(); const start = vi.fn(); const dispose = vi.fn();
    const load = vi.fn(async () => ({ bootstrap(registrar: CapabilityRegistrar) { registrar.defer(dispose); registrar.onReady(start); registrar.register("ping", Type.Null(), Type.String(), () => "running"); } }));
    const runtime = createCapabilityRuntime(prepared, registry, load); const client = worker(); const changed = vi.fn(); runtime.subscribe(changed);
    await runtime.start(client, services);
    expect(start).toHaveBeenCalledOnce(); expect(runtime.list()[0]).toMatchObject({ status: "ready", enabledNextStart: true, navigation: { route: "test-package" } });
    await runtime.setEnabled("test-package", false);
    expect(dispose).not.toHaveBeenCalled();
    expect(await registry.call({ capabilityId: "test-package", operation: "ping", requestId: "request", input: null })).toBe("running");
    client.exit();
    expect(registry.readyIds()).toEqual([]); expect(runtime.list()[0]).toMatchObject({ status: "failed", enabledNextStart: false }); expect(runtime.list()[0]?.navigation).toBeUndefined();
    const replacement = worker(); await runtime.start(replacement, services);
    expect(replacement.activateCapability.mock.calls).toEqual(client.activateCapability.mock.calls.map(args => expect.arrayContaining(args.slice(0, 2))));
    expect(runtime.list()[0]?.status).toBe("ready"); expect(runtime.workerSnapshot).toBe(prepared.workerSnapshot); expect(changed).toHaveBeenCalled();
    await runtime.dispose(); expect(registry.readyIds()).toEqual([]);
  });
  it("rolls back Worker failure without starting business recovery", async () => {
    const { prepared } = await fixture(); const registry = new CapabilityRegistry(); const recover = vi.fn(); const dispose = vi.fn();
    const runtime = createCapabilityRuntime(prepared, registry, async () => ({ bootstrap(registrar: CapabilityRegistrar) { registrar.onReady(recover); registrar.defer(dispose); } }));
    const client = worker(); client.activateCapability.mockRejectedValueOnce(new Error("failed"));
    await runtime.start(client, services);
    expect(recover).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce(); expect(registry.readyIds()).toEqual([]); expect(runtime.list()[0]?.status).toBe("failed");
  });
  it.each(["dispose", "exit"])("does not publish late activation or start later packages after %s", async interruption => {
    const { paths } = await fixture(); await writeTestPackage(paths.scanRoot, "second-package");
    await writeEnabledIds(paths.statePath, ["test-package", "second-package"]);
    const prepared = await prepareCapabilities(paths); const registry = new CapabilityRegistry();
    const started = vi.fn(); const cleaned = vi.fn();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const loading = new Promise<void>(resolve => { entered = resolve; });
    const load = vi.fn(async () => { entered(); await gate; return { bootstrap(registrar: CapabilityRegistrar) { registrar.defer(cleaned); registrar.onReady(started); } }; });
    const runtime = createCapabilityRuntime(prepared, registry, load); const client = worker();
    const pending = runtime.start(client, services); await loading;
    if (interruption === "dispose") await runtime.dispose(); else client.exit();
    release(); await pending;
    expect(load).toHaveBeenCalledOnce(); expect(started).not.toHaveBeenCalled();
    expect(registry.readyIds()).toEqual([]); expect(runtime.list().every(entry => entry.status === "failed" && !entry.navigation)).toBe(true);
  });
  it("rejects unknown requirements before import and rejects forged Worker paths", async () => {
    const { prepared } = await fixture(["unknown.adapter"]); const load = vi.fn();
    const runtime = createCapabilityRuntime(prepared, new CapabilityRegistry(), load); await runtime.start(worker(), services);
    expect(load).not.toHaveBeenCalled(); expect(runtime.list()[0]).toMatchObject({ status: "incompatible", issue: "missing_host_service" });
    const loader = createSnapshotWorkerLoader(prepared.workerSnapshot, services, load);
    const registrar = { register: vi.fn(), defer: vi.fn() };
    await expect(loader({ capabilityId: "test-package", entry: "/forged.js" }, registrar)).rejects.toThrow("capability_unavailable");
    await expect(loader({ capabilityId: "foreign-package", entry: "/forged.js" }, registrar)).rejects.toThrow("capability_unavailable");
    expect(load).not.toHaveBeenCalled();
    const captured = prepared.workerSnapshot[0]!;
    const outside = await writeTestPackage(join(dirname(prepared.paths.scanRoot), "outside"));
    await rm(captured.root, { recursive: true }); await symlink(outside, captured.root);
    await expect(loader({ capabilityId: "test-package", entry: join(outside, "dist/worker.js") }, registrar)).rejects.toThrow("capability_unavailable");
    expect(load).not.toHaveBeenCalled();
  });
  it("keeps removed packages, disabled packages, old IDs and corrupt state out of startup", async () => {
    const { paths } = await fixture(); await writeEnabledIds(paths.statePath, ["old-package"]);
    const disabled = await prepareCapabilities(paths); expect(disabled.selected).toEqual([]);
    await writeFile(paths.statePath, "{"); const corrupt = await prepareCapabilities(paths);
    expect(corrupt.selected).toEqual([]); expect(corrupt.issues).toContainEqual({ packageName: ".", code: "capability_state_unavailable" });
    await writeFile(paths.statePath, JSON.stringify({ schemaVersion: 1, initialized: true, enabledIds: ["test-package"] }));
    await rm(paths.scanRoot, { recursive: true }); const removed = await prepareCapabilities(paths);
    const load = vi.fn(); await createCapabilityRuntime(removed, new CapabilityRegistry(), load).start(worker(), services);
    expect(load).not.toHaveBeenCalled(); expect(removed.workerSnapshot).toEqual([]);
  });
});
