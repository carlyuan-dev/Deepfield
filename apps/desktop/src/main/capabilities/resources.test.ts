import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCapabilityResourceResolver } from "./resources.js";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("serves only regular allowed resources of the fixed ready snapshot", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capability-resources-")));
  temporaryRoots.push(root);
  const packageRoot = join(root, "package");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "dist/ui.js"), "export {};");
  await writeFile(join(packageRoot, "dist/ui.css"), ".page {}");
  await writeFile(join(root, "outside.js"), "secret");
  await symlink(join(root, "outside.js"), join(packageRoot, "dist/link.js"));
  await mkdir(join(packageRoot, "dist/directory.js"));
  const snapshot = [{ id: "research", root: packageRoot, state: "ready" as const }, { id: "disabled", root: packageRoot, state: "disabled" as const }];
  const resolve = await createCapabilityResourceResolver(snapshot);
  snapshot[0]!.id = "mutated";
  expect(await resolve({ method: "GET", url: "deepfield-capability://research/dist/ui.js" })).toEqual({ path: join(packageRoot, "dist/ui.js"), mimeType: "text/javascript" });
  expect(await resolve({ method: "GET", url: "deepfield-capability://research/dist/ui.css" })).toEqual({ path: join(packageRoot, "dist/ui.css"), mimeType: "text/css" });
  for (const url of [
    "deepfield-capability://disabled/dist/ui.js", "deepfield-capability://unknown/dist/ui.js",
    "deepfield-capability://research/%2e%2e/outside.js", "deepfield-capability://research/dist/%2e%2e/%2e%2e/outside.js",
    "deepfield-capability://research/%252e%252e/outside.js", "deepfield-capability://research//etc/passwd.js",
    "deepfield-capability://research/C:%5csecret.js", "deepfield-capability://research/dist/link.js",
    "deepfield-capability://research/dist/directory.js", "deepfield-capability://research/capability.json",
    "deepfield-capability://research/dist/ui.js?file=outside", "https://research/dist/ui.js",
  ]) expect(await resolve({ method: "GET", url }), url).toBeUndefined();
  expect(await resolve({ method: "POST", url: "deepfield-capability://research/dist/ui.js" })).toBeUndefined();
});
