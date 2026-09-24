import { afterEach, describe, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { actionFixture, testContext } from "./action-test-helpers.js";
const fixtures: Awaited<ReturnType<typeof actionFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.runtime.dispose(); await rm(f.root, { recursive: true, force: true }); } });
async function fixture(...args: Parameters<typeof actionFixture>) { const f = await actionFixture(...args); fixtures.push(f); return f; }
describe("startup action catalog", () => {
  it("publishes main-only public actions after ready, preserves snapshot on preferences and worker exit", async () => {
    const f = await fixture();
    expect(f.runtime.actionCatalog.list()).toEqual([]);
    await f.start();
    expect(f.runtime.list()[0]?.status).toBe("ready"); expect(f.workerCalls()).toBe(0);
    const catalog = f.runtime.actionCatalog.list();
    expect(catalog.map(action => action.actionId)).toEqual(["run"]);
    await f.runtime.setEnabled("public-package", false); f.exit();
    expect(f.runtime.actionCatalog.list()).toEqual(catalog); expect(f.registry.readyIds()).toEqual(["public-package"]);
    expect(await f.runtime.actionGateway.describe(f.call, testContext)).toMatchObject({ status: "described", documentation: "Validated action documentation." });
    await writeFile(join(f.paths.scanRoot, "public-package", "action.md"), "changed on disk");
    expect(await f.runtime.actionGateway.describe(f.call, testContext)).toMatchObject({ documentation: "Validated action documentation." });
  });
  it.each(["missing", "extra", "metadata", "digest"])("rejects %s registrations before publication", async kind => {
    const f = await fixture(undefined, (registrar, declaration) => {
      if (kind === "missing") return;
      const definition = { ...f.action, ...(kind === "metadata" ? { requiresConfirmation: false } : {}) };
      registrar.registerAction!({ definition, declaration: { ...declaration, ...(kind === "digest" ? { contractDigest: `sha256:${"0".repeat(64)}` } : {}) } });
      if (kind === "extra") registrar.registerAction!({ definition: { ...definition, id: "extra" }, declaration: { ...declaration, id: "extra" } });
    });
    await f.start(); expect(f.runtime.list()[0]?.status).toBe("failed"); expect(f.runtime.actionCatalog.list()).toEqual([]);
  });
  it("fails activation when shipped documentation no longer matches digest", async () => {
    const f = await fixture(); await writeFile(join(f.paths.scanRoot, "public-package", "action.md"), "tampered");
    await f.start(); expect(f.registry.readyIds()).toEqual([]); expect(f.runtime.actionCatalog.list()).toEqual([]);
  });
});
