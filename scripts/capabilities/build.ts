import { mkdir, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

// An absent source root is a supported host-only distribution. Clear previous
// build products so removing sources cannot accidentally ship a stale package.
const output = resolve("out/capabilities");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const source = resolve("capabilities");
const entries = await readdir(source, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const builder = await import(pathToFileURL(join(source, entry.name, "build.ts")).href) as { buildPackage(outDir: string): Promise<void> };
  await builder.buildPackage(join(output, entry.name));
}
