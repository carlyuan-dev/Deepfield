import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnabledIds, writeEnabledIds } from "./preferences.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("distinguishes missing, legacy, valid and corrupt preferences; writes atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "capability-state-test-")); roots.push(root); const path = join(root, "state.json");
  expect(await readEnabledIds(path)).toEqual([]);
  await writeFile(path, JSON.stringify({ enabledIds: ["missing-old-package"] }));
  expect(await readEnabledIds(path)).toEqual(["missing-old-package"]);
  await writeEnabledIds(path, ["missing-old-package", "new-package"]);
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schemaVersion: 1, initialized: true });
  expect(await readdir(root)).toEqual(["state.json"]);
  for (const corrupt of ["{", "null", '{"schemaVersion":1,"enabledIds":[]}', '{"enabledIds":[7]}']) {
    await writeFile(path, corrupt);
    await expect(readEnabledIds(path)).rejects.toThrow("capability_state_corrupt");
    await expect(writeEnabledIds(path, [])).rejects.toThrow("capability_state_corrupt");
    expect(await readFile(path, "utf8")).toBe(corrupt);
  }
});
