import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { createCapabilityHostServices, type CapabilityHostServices, type CapabilityRegistrar } from "@deepfield/capability-sdk";
import { createConfigRuntime } from "@deepfield/base/config/runtime";
import { defineConfig, type ConfigHandle, type ScopedConfigService } from "@deepfield/base/config";
import { createScopedConfigFileStore } from "../config-file-store.js";
import { prepareCapabilities, createCapabilityRuntime } from "./runtime.js";
import { CapabilityRegistry } from "./registry.js";
import { writeEnabledIds } from "./preferences.js";
import { writeTestPackage } from "./startup-test-helpers.js";
import { createSnapshotWorkerLoader } from "../../shared/capability-entry.js";
import { openDatabase } from "@deepfield/base/database/runtime";
import type { Database } from "@deepfield/base/database";
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
  it("keeps scoped database usable through cleanup, revokes failed/old handles and creates a fresh restart scope", async () => {
    const { prepared } = await fixture(["database.v1"]); const owner = openDatabase(":memory:");
    owner.database.exec("CREATE TABLE receipts(value TEXT)");
    const handles: Database[] = []; let fail = true;
    const runtime = createCapabilityRuntime(prepared, new CapabilityRegistry(), async () => ({ bootstrap(registrar, host) {
      const db = host.get<Database>("database.v1"); handles.push(db);
      registrar.defer(async () => { await Promise.resolve(); db.run("INSERT INTO receipts VALUES ('paused')"); });
      if (fail) throw new Error("bootstrap_failed");
    } }), undefined, { databaseOwner: owner });
    try {
      await runtime.start(worker(), services); expect(runtime.list()[0]?.status).toBe("failed");
      expect(() => handles[0]!.get("SELECT 1")).toThrow("closed");
      fail = false; await runtime.start(worker(), services); const old = handles[1]!;
      await runtime.start(worker(), services); expect(() => old.get("SELECT 1")).toThrow("closed");
      expect(handles[2]!.get("SELECT 1 AS value")).toEqual({ value: 1 });
      await runtime.dispose(); expect(() => handles[2]!.get("SELECT 1")).toThrow("closed");
      expect(owner.database.all("SELECT value FROM receipts")).toEqual([{ value: "paused" }, { value: "paused" }, { value: "paused" }]);
    } finally { await runtime.dispose(); owner.close(); }
  });
  it("rejects wrong Database versions and missing audit methods before calling bootstrap", async () => {
    const { prepared } = await fixture(["database.v1", "tools.audit.v1"]); const owner = openDatabase(":memory:");
    const bootstrap = vi.fn();
    try {
      for (const supplied of [
        { "database.v1": { ...owner.database, version: 2 }, "tools.audit.v1": { version: 1, deleteByTraceIds() { return 0; } } },
        { "database.v1": owner.database, "tools.audit.v1": { version: 1 } },
      ]) {
        const runtime = createCapabilityRuntime(prepared, new CapabilityRegistry(), async () => ({ bootstrap }));
        await runtime.start(worker(), createCapabilityHostServices(supplied));
        expect(runtime.list()[0]).toMatchObject({ status: "incompatible", issue: "incompatible_host_service" });
        await runtime.dispose();
      }
      expect(bootstrap).not.toHaveBeenCalled();
    } finally { owner.close(); }
  });
  it("isolates failed module migrations and exposes only safe diagnostics while host writes remain available", async () => {
    const { prepared } = await fixture(["database.v1"]); const owner = openDatabase(":memory:");
    owner.database.exec("CREATE TABLE host_messages(content TEXT)");
    const runtime = createCapabilityRuntime(prepared, new CapabilityRegistry(), async () => ({ bootstrap(_registrar, host) {
      host.get<Database>("database.v1").migrate([{ version: 1, key: "fail", up(db) { db.run("INSERT INTO host_messages VALUES (?)", "secret"); throw new Error("SECRET SQL/key"); } }], () => {});
    } }), undefined, { databaseOwner: owner });
    try {
      await runtime.start(worker(), services);
      expect(runtime.list()[0]).toMatchObject({ status: "failed", databaseDiagnostic: { namespace: "capability:test-package", version: 1, stage: "apply" } });
      expect(JSON.stringify(runtime.list())).not.toMatch(/SECRET|secret/);
      owner.database.run("INSERT INTO host_messages VALUES ('chat usable')");
      expect(owner.database.all("SELECT content FROM host_messages")).toEqual([{ content: "chat usable" }]);
    } finally { await runtime.dispose(); owner.close(); }
  });
  it("expires scoped handles on activation failure, Worker restart and disposal, preserving next-start data", async () => {
    const { prepared } = await fixture(["config.v1"]); const registry = new CapabilityRegistry();
    const secretValues = new Map<string, string>(); let id = 0;
    const documents = createScopedConfigFileStore(join(dirname(prepared.paths.scanRoot), "config"));
    const config = createConfigRuntime({ documents, secrets: { has: ref => secretValues.has(ref), get: ref => secretValues.get(ref),
      set: (ref, value) => { secretValues.set(ref, value); }, delete: ref => { secretValues.delete(ref); } }, newId: () => `id-${++id}` });
    const handles: ConfigHandle<{ value: string }>[] = [];
    const definition = defineConfig({ key: "private", schemaVersion: 1, schema: Type.Object({ value: Type.String() }), defaults: { value: "default" } });
    let fail = true; const scopes: string[] = [];
    const modelConfiguration = {};
    const runtime = createCapabilityRuntime(prepared, registry, async () => ({ bootstrap(_registrar: CapabilityRegistrar, host: CapabilityHostServices) {
      expect(host.version).toBe(1); expect(host.get("model.configuration")).toBe(modelConfiguration);
      handles.push(host.get<ScopedConfigService>("config.v1").bind(definition));
      if (fail) throw new Error("test failure");
    } }), undefined, { createConfigScope: capabilityId => { scopes.push(capabilityId); return config.createScope(capabilityId); } });
    const host = createCapabilityHostServices({ "model.configuration": modelConfiguration });
    await runtime.start(worker(), host);
    expect(runtime.list()[0]?.status).toBe("failed"); await expect(handles[0]!.getView()).rejects.toThrow();
    fail = false; const client = worker(); await runtime.start(client, host);
    const handle = handles[1]!; await handle.save({ values: { value: "saved" } });
    const snapshot = await handle.resolveSnapshot();
    await runtime.setEnabled("test-package", false);
    expect((await handle.getView()).values.value).toBe("saved");
    client.exit(); await expect(handle.getView()).rejects.toThrow();
    await runtime.start(worker(), host);
    expect((await handles[2]!.getView()).values.value).toBe("saved");
    expect(snapshot.values.value).toBe("saved");
    expect(scopes).toEqual(["test-package", "test-package", "test-package"]);
    await runtime.dispose(); await expect(handles[2]!.save({ values: { value: "late" } })).rejects.toThrow();
    expect((await config.createScope("test-package").service.bind(definition).getView()).values.value).toBe("saved");
  });
  it("does not create scopes for disabled or incompatible packages and supports an old host without config", async () => {
    const { paths } = await fixture(["config.v1"]); await writeEnabledIds(paths.statePath, []);
    const createConfigScope = vi.fn(); const load = vi.fn();
    const runtime = createCapabilityRuntime(await prepareCapabilities(paths), new CapabilityRegistry(), load, undefined, { createConfigScope });
    await runtime.start(worker(), services); expect(createConfigScope).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled(); await runtime.dispose();
    await writeEnabledIds(paths.statePath, ["test-package"]);
    const oldHost = createCapabilityRuntime(await prepareCapabilities(paths), new CapabilityRegistry(), load);
    await oldHost.start(worker(), services); expect(oldHost.list()[0]?.status).toBe("incompatible"); expect(load).not.toHaveBeenCalled(); await oldHost.dispose();
  });
  it("isolates corrupt package data and never reads or migrates disabled data", async () => {
    const { paths } = await fixture(["config.v1"]);
    await writeTestPackage(paths.scanRoot, "healthy-package", ["config.v1"]);
    await writeTestPackage(paths.scanRoot, "disabled-package", ["config.v1"]);
    await writeEnabledIds(paths.statePath, ["test-package", "healthy-package"]);
    const prepared = await prepareCapabilities(paths);
    const files = createScopedConfigFileStore(join(dirname(paths.scanRoot), "config"));
    files.write({ scope: "test-package", key: "preferences" }, { corrupt: true });
    const reads: string[] = []; const scopes: string[] = []; let migrations = 0; let id = 0;
    const config = createConfigRuntime({ documents: { read: address => { reads.push(address.scope); return files.read(address); }, write: files.write },
      secrets: { has: () => false, get: () => undefined, set() {}, delete() {} }, newId: () => `id-${++id}` });
    const definition = defineConfig({ key: "preferences", schemaVersion: 2, schema: Type.Object({ value: Type.String() }), defaults: { value: "default" },
      migrations: { 1: values => { migrations++; return values; } } });
    const registry = new CapabilityRegistry();
    const runtime = createCapabilityRuntime(prepared, registry, async () => ({ async bootstrap(registrar: CapabilityRegistrar, host: CapabilityHostServices) {
      const handle = host.get<ScopedConfigService>("config.v1").bind(definition);
      const view = await handle.getView();
      registrar.register("read", Type.Null(), Type.String(), () => view.values.value);
    } }), undefined, { createConfigScope: scope => { scopes.push(scope); return config.createScope(scope); } });
    expect(reads).toEqual([]); await runtime.start(worker(), services);
    expect(runtime.list().find(entry => entry.id === "test-package")?.status).toBe("failed");
    expect(runtime.list().find(entry => entry.id === "healthy-package")?.status).toBe("ready");
    expect(runtime.list().find(entry => entry.id === "disabled-package")?.status).toBe("disabled");
    expect(scopes.sort()).toEqual(["healthy-package", "test-package"]);
    expect(reads.sort()).toEqual(["healthy-package", "test-package"]); expect(migrations).toBe(0);
    expect(await registry.call({ capabilityId: "healthy-package", operation: "read", requestId: "read", input: null })).toBe("default");
    expect(files.read({ scope: "test-package", key: "preferences" })).toEqual({ corrupt: true });
    await runtime.dispose();
  });
  it("revokes config before waiting for asynchronous package cleanup", async () => {
    const { prepared } = await fixture(["config.v1"]); const registry = new CapabilityRegistry();
    const config = createConfigRuntime({ documents: { read: () => undefined, write() {} },
      secrets: { has: () => false, get: () => undefined, set() {}, delete() {} }, newId: () => "test-id" });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let handle!: ConfigHandle<{ value: string }>;
    const runtime = createCapabilityRuntime(prepared, registry, async () => ({ bootstrap(registrar: CapabilityRegistrar, host: CapabilityHostServices) {
      handle = host.get<ScopedConfigService>("config.v1").bind(defineConfig({ key: "private", schemaVersion: 1,
        schema: Type.Object({ value: Type.String() }), defaults: { value: "default" } }));
      registrar.defer(() => gate);
    } }), undefined, { createConfigScope: scope => config.createScope(scope) });
    const client = worker(); await runtime.start(client, services); client.exit();
    await expect(handle.getView()).rejects.toThrow();
    release(); await runtime.dispose();
  });
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
    expect(runtime.helpEntries()).toEqual([]);
  });
  it.each(["dispose", "exit"])("does not publish late activation or start later packages after %s", async interruption => {
    const { paths } = await fixture(); await writeTestPackage(paths.scanRoot, "second-package");
    await writeEnabledIds(paths.statePath, ["test-package", "second-package"]);
    const prepared = await prepareCapabilities(paths); const registry = new CapabilityRegistry();
    const started = vi.fn(); const cleaned = vi.fn();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const loading = new Promise<void>(resolve => { entered = resolve; });
    const bootstrap = vi.fn((registrar: CapabilityRegistrar) => { registrar.defer(cleaned); registrar.onReady(started); });
    const load = vi.fn(async () => { entered(); await gate; return { bootstrap }; });
    const runtime = createCapabilityRuntime(prepared, registry, load); const client = worker();
    const pending = runtime.start(client, services); await loading;
    if (interruption === "dispose") await runtime.dispose(); else client.exit();
    release(); await pending;
    expect(load).toHaveBeenCalledOnce(); expect(started).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled(); expect(client.activateCapability).not.toHaveBeenCalled();
    expect(registry.readyIds()).toEqual([]); expect(runtime.list().every(entry => entry.status === "failed" && !entry.navigation)).toBe(true);
  });
  it("awaits cleanup already started by Worker exit before replacement recovery", async () => {
    const { prepared } = await fixture(); const registry = new CapabilityRegistry();
    let release!: () => void; let cleanupEntered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cleaning = new Promise<void>(resolve => { cleanupEntered = resolve; });
    const started = vi.fn(); let bootstraps = 0;
    const runtime = createCapabilityRuntime(prepared, registry, async () => ({ bootstrap(registrar: CapabilityRegistrar) {
      if (++bootstraps === 1) registrar.defer(async () => { cleanupEntered(); await gate; });
      registrar.onReady(started);
    } }));
    const old = worker(); await runtime.start(old, services); old.exit(); await cleaning;
    const replacement = worker(); const pending = runtime.start(replacement, services);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(runtime.list()[0]?.status).toBe("failed");
    expect(bootstraps).toBe(1); expect(started).toHaveBeenCalledOnce(); expect(replacement.activateCapability).not.toHaveBeenCalled();
    release(); await pending;
    expect(bootstraps).toBe(2); expect(started).toHaveBeenCalledTimes(2); await runtime.dispose();
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
    expect(createCapabilityRuntime(removed, new CapabilityRegistry(), load).actionCatalog.list()).toEqual([]);
  });
  it("keeps main-only packages alive during Worker exit and replacement without rebootstrap", async () => {
    const { paths } = await fixture();
    const root = await writeTestPackage(paths.scanRoot, "main-only");
    await mkdir(join(root, "docs")); await writeFile(join(root, "docs/help.md"), "用户帮助。\n\n例如：查看事项");
    await writeFile(join(root, "capability.json"), JSON.stringify({ id: "main-only", name: "Main", description: "technical description", version: "1.0.0", protocolVersion: 2, hostApiVersion: 2, entries: { main: "dist/main.js" }, help: "docs/help.md", actions: [], requirements: [] }));
    await writeEnabledIds(paths.statePath, ["main-only", "test-package"]);
    const prepared = await prepareCapabilities(paths); const registry = new CapabilityRegistry();
    const boots: string[] = []; const cleanups: string[] = [];
    const runtime = createCapabilityRuntime(prepared, registry, async entry => ({ bootstrap(registrar: CapabilityRegistrar) {
      boots.push(entry.id); registrar.defer(() => { cleanups.push(entry.id); });
      registrar.register("private", Type.Null(), Type.String(), () => entry.id);
    } }));
    const client = worker(); await runtime.start(client, services);
    expect(runtime.actionCatalog.list()).toEqual([]); // v1 private operations never become actions
    expect(runtime.helpEntries()).toEqual([{ name: "Main", markdown: "用户帮助。\n\n例如：查看事项" }, { name: "test-package" }]);
    client.exit(); expect(registry.readyIds()).toEqual(["main-only"]);
    expect(runtime.helpEntries()).toEqual([{ name: "Main", markdown: "用户帮助。\n\n例如：查看事项" }]);
    await runtime.start(worker(), services);
    expect(boots.filter(id => id === "main-only")).toHaveLength(1); expect(cleanups).not.toContain("main-only");
    expect(await registry.call({ capabilityId: "main-only", operation: "private", requestId: "request", input: null })).toBe("main-only");
    await runtime.dispose(); expect(cleanups).toContain("main-only");
  });
});
