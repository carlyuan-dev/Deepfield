import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeCapabilities } from "./installation.js";
import { readEnabledIds, writeEnabledIds } from "./preferences.js";
import { scanCapabilities } from "./catalog.js";
import { writeTestPackage } from "./startup-test-helpers.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "capability-install-test-")); roots.push(root);
  return { root, scanRoot: join(root, "installed"), bundledRoot: join(root, "bundled"), statePath: join(root, "state.json") };
}
describe("capability installation", () => {
  it("copies and enables a complete first install, preserves next-start choice on second start", async () => {
    const paths = await fixture(); await writeTestPackage(paths.bundledRoot);
    await initializeCapabilities(paths);
    expect(await readEnabledIds(paths.statePath)).toEqual(["test-package"]);
    expect((await scanCapabilities(paths.scanRoot)).entries).toHaveLength(1);
    expect(JSON.parse(await readFile(paths.statePath, "utf8"))).toMatchObject({ schemaVersion: 1, initialized: true });
    await writeEnabledIds(paths.statePath, []); await initializeCapabilities(paths);
    expect(await readEnabledIds(paths.statePath)).toEqual([]);
  });
  it.each(["package", "root"])("does not restore a deleted initialized %s", async target => {
    const paths = await fixture(); await writeTestPackage(paths.bundledRoot); await initializeCapabilities(paths);
    await rm(target === "root" ? paths.scanRoot : join(paths.scanRoot, "test-package"), { recursive: true });
    await initializeCapabilities(paths);
    expect(await scanCapabilities(paths.scanRoot)).toEqual({ entries: [], issues: [] });
  });
  it("keeps manual packages untouched and disabled", async () => {
    const paths = await fixture(); await writeTestPackage(paths.bundledRoot);
    const manual = await writeTestPackage(paths.scanRoot);
    await writeFile(join(manual, "dist/main.js"), "// manual");
    await initializeCapabilities(paths);
    expect(await readFile(join(manual, "dist/main.js"), "utf8")).toBe("// manual");
    expect(await readEnabledIds(paths.statePath)).toEqual([]);
  });
  it("ignores an interrupted sibling staging directory and resumes published install intent", async () => {
    const paths = await fixture(); await writeTestPackage(join(paths.root, ".capability-install-interrupted"));
    expect(await scanCapabilities(paths.scanRoot)).toEqual({ entries: [], issues: [] });
    await writeTestPackage(paths.bundledRoot); await writeTestPackage(paths.scanRoot);
    await writeFile(paths.statePath, JSON.stringify({ schemaVersion: 1, initialized: false, enabledIds: ["test-package"] }));
    await initializeCapabilities(paths);
    expect(await readEnabledIds(paths.statePath)).toEqual(["test-package"]);
  });
  it("does not initialize from a missing build or repair corrupt preferences", async () => {
    const paths = await fixture(); await initializeCapabilities(paths);
    expect(await scanCapabilities(paths.scanRoot)).toEqual({ entries: [], issues: [] });
    await writeTestPackage(paths.bundledRoot); await writeFile(paths.statePath, "{");
    await expect(initializeCapabilities(paths)).rejects.toThrow("capability_state_corrupt");
    expect(await scanCapabilities(paths.scanRoot)).toEqual({ entries: [], issues: [] });
  });
});
