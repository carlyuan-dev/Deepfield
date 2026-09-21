import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCapabilities, selectCapabilities, type CapabilityFileSystem } from "./catalog.js";

function manifest(id: string) {
  return {
    id,
    name: id,
    description: `${id} capability`,
    version: "1.0.0",
    protocolVersion: 1,
    hostApiVersion: 1,
    entries: { main: "dist/main.js", worker: "dist/worker.js" },
    requirements: [],
    actions: [{
      id: `${id}.run`,
      description: "Run",
      mode: "immediate",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      documentation: { path: "docs/run.md", version: "1" },
      permissions: [],
      requiresConfirmation: false,
    }],
  };
}

async function makePackage(root: string, directory: string, value = manifest(directory)) {
  const packageRoot = join(root, directory);
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await mkdir(join(packageRoot, "docs"), { recursive: true });
  await Promise.all([
    writeFile(join(packageRoot, "capability.json"), JSON.stringify(value)),
    writeFile(join(packageRoot, "dist/main.js"), "export {}"),
    writeFile(join(packageRoot, "dist/worker.js"), "export {}"),
    writeFile(join(packageRoot, "docs/run.md"), "# Run"),
  ]);
}

describe("scanCapabilities", () => {
  it("treats a missing or empty package root as an empty catalog", async () => {
    const parent = await mkdtemp(join(tmpdir(), "deepfield-catalog-"));
    expect(await scanCapabilities(join(parent, "missing"))).toEqual({ entries: [], issues: [] });
    const empty = join(parent, "empty");
    await mkdir(empty);
    expect(await scanCapabilities(empty)).toEqual({ entries: [], issues: [] });
  });

  it("keeps valid siblings when another manifest is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepfield-catalog-"));
    await makePackage(root, "good");
    await mkdir(join(root, "broken"));
    await writeFile(join(root, "broken/capability.json"), "{");

    const catalog = await scanCapabilities(root);

    expect(catalog.entries.map(({ manifest: value }) => value.id)).toEqual(["good"]);
    expect(catalog.issues).toContainEqual({ packageName: "broken", code: "invalid_manifest" });
  });

  it("removes every package sharing a duplicate id", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepfield-catalog-"));
    await makePackage(root, "first", manifest("same"));
    await makePackage(root, "second", manifest("same"));

    const catalog = await scanCapabilities(root);

    expect(catalog.entries).toEqual([]);
    expect(catalog.issues).toEqual([
      { packageName: "first", code: "duplicate_id" },
      { packageName: "second", code: "duplicate_id" },
    ]);
  });

  it("reports a controlled root permission failure without throwing", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const fileSystem = { readdir: async () => { throw denied; } } as unknown as CapabilityFileSystem;

    await expect(scanCapabilities("/packages", fileSystem)).resolves.toEqual({
      entries: [],
      issues: [{ packageName: ".", code: "scan_failed" }],
    });
  });

  it("does not scan nested package directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepfield-catalog-"));
    await mkdir(join(root, "outer"));
    await makePackage(join(root, "outer"), "nested");
    expect(await scanCapabilities(root)).toEqual({ entries: [], issues: [{ packageName: "outer", code: "manifest_missing" }] });
  });
});

describe("selectCapabilities", () => {
  it("ignores stale ids and returns a deeply immutable startup snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepfield-catalog-"));
    await makePackage(root, "probe");
    const catalog = await scanCapabilities(root);
    const selected = selectCapabilities(catalog, ["missing", "probe"]);

    expect(selected.map(({ manifest: value }) => value.id)).toEqual(["probe"]);
    expect(Object.isFrozen(selected)).toBe(true);
    const selectedEntry = selected[0]!;
    const selectedAction = selectedEntry.manifest.actions[0]!;
    expect(Object.isFrozen(selectedEntry)).toBe(true);
    expect(Object.isFrozen(selectedAction.documentation)).toBe(true);

    catalog.entries[0]!.manifest.name = "mutated";
    expect(selectedEntry.manifest.name).toBe("probe");
    expect(() => { selectedAction.documentation.version = "2"; }).toThrow();
  });
});
