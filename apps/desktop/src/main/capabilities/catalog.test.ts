import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
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

function deeplyNestedArraySchema(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < depth; index += 1) schema = { type: "array", items: schema };
  return schema;
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

  it("keeps valid siblings when recursive manifest validation overflows", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepfield-catalog-"));
    await makePackage(root, "good");
    const nested = manifest("nested");
    (nested.actions[0] as { inputSchema: Record<string, unknown> }).inputSchema = deeplyNestedArraySchema(3_000);
    await makePackage(root, "nested", nested);

    await expect(scanCapabilities(root)).resolves.toMatchObject({
      entries: [{ manifest: { id: "good" } }],
      issues: [{ packageName: "nested", code: "invalid_manifest" }],
    });
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

  it("stores the same canonical package root when the scan root is a symlink alias", async () => {
    const parent = await mkdtemp(join(tmpdir(), "deepfield-catalog-"));
    const root = join(parent, "packages");
    const alias = join(parent, "packages-alias");
    await mkdir(root);
    await makePackage(root, "probe");
    await symlink(root, alias);

    const [direct, throughAlias, canonicalPackageRoot] = await Promise.all([
      scanCapabilities(root),
      scanCapabilities(alias),
      realpath(join(root, "probe")),
    ]);

    expect(direct.entries[0]!.root).toBe(canonicalPackageRoot);
    expect(throughAlias.entries[0]!.root).toBe(canonicalPackageRoot);
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
