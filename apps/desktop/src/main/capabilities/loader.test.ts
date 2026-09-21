import { describe, expect, it } from "vitest";
import type { CapabilityManifest } from "@deepfield/capability-sdk";
import { selectCapabilities, type CatalogEntry } from "./catalog.js";
import { activateCapabilities, type ActivationAdapter } from "./loader.js";

function entry(id: string): CatalogEntry {
  const manifest: CapabilityManifest = {
    id,
    name: id,
    description: `${id} capability`,
    version: "1.0.0",
    protocolVersion: 1,
    hostApiVersion: 1,
    entries: { main: "dist/main.js", worker: "dist/worker.js" },
    requirements: [],
    actions: [],
  };
  return { root: `/capabilities/${id}`, manifest };
}

describe("activateCapabilities", () => {
  it("does not call the adapter when no capabilities are selected", async () => {
    const adapter: ActivationAdapter = {
      async activateMain() { throw new Error("unexpected main activation"); },
      async activateWorker() { throw new Error("unexpected worker activation"); },
    };

    const result = await activateCapabilities([], adapter);

    expect(result.ready).toEqual([]);
    expect(result.issues).toEqual([]);
    await result.dispose();
  });

  it("does not execute a disabled package", async () => {
    const enabled = entry("enabled");
    const disabled = entry("disabled");
    const selected = selectCapabilities({ entries: [enabled, disabled], issues: [] }, ["enabled"]);
    const activated: string[] = [];
    const adapter: ActivationAdapter = {
      async activateMain(value) { activated.push(`main:${value.manifest.id}`); },
      async activateWorker(value) { activated.push(`worker:${value.manifest.id}`); },
    };

    const result = await activateCapabilities(selected, adapter);

    expect(activated).toEqual(["main:enabled", "worker:enabled"]);
    expect(result.ready.map((value) => value.manifest.id)).toEqual(["enabled"]);
    await result.dispose();
  });

  it("rolls back a partial package in reverse order and continues with the next package", async () => {
    const calls: string[] = [];
    const adapter: ActivationAdapter = {
      async activateMain(value, defer) {
        calls.push(`main:${value.manifest.id}`);
        defer(() => { calls.push(`cleanup-main:${value.manifest.id}`); });
      },
      async activateWorker(value, defer) {
        calls.push(`worker:${value.manifest.id}`);
        defer(() => { calls.push(`cleanup-worker:${value.manifest.id}:first`); });
        defer(() => { calls.push(`cleanup-worker:${value.manifest.id}:second`); });
        if (value.manifest.id === "broken") throw new Error("sensitive worker failure");
      },
    };

    const result = await activateCapabilities([entry("broken"), entry("healthy")], adapter);

    expect(calls).toEqual([
      "main:broken",
      "worker:broken",
      "cleanup-worker:broken:second",
      "cleanup-worker:broken:first",
      "cleanup-main:broken",
      "main:healthy",
      "worker:healthy",
    ]);
    expect(result.ready.map((value) => value.manifest.id)).toEqual(["healthy"]);
    expect(result.issues).toEqual([{ packageName: "broken", code: "activation_failed" }]);
    expect(JSON.stringify(result.issues)).not.toContain("sensitive");

    await Promise.all([result.dispose(), result.dispose()]);
    await result.dispose();
    expect(calls.slice(-3)).toEqual([
      "cleanup-worker:healthy:second",
      "cleanup-worker:healthy:first",
      "cleanup-main:healthy",
    ]);
  });

  it("reports safe cleanup issues without interrupting remaining cleanup", async () => {
    const calls: string[] = [];
    const adapter: ActivationAdapter = {
      async activateMain(_value, defer) {
        defer(() => { calls.push("main cleanup"); });
      },
      async activateWorker(_value, defer) {
        defer(() => { throw new Error("sensitive cleanup failure"); });
      },
    };
    const result = await activateCapabilities([entry("cleanup-probe")], adapter);

    await result.dispose();

    expect(calls).toEqual(["main cleanup"]);
    expect(result.issues).toEqual([{ packageName: "cleanup-probe", code: "cleanup_failed" }]);
    expect(JSON.stringify(result.issues)).not.toContain("sensitive");
  });
});
