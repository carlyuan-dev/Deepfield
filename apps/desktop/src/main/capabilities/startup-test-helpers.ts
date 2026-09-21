import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityManifest } from "@deepfield/capability-sdk";
export async function writeTestPackage(root: string, id = "test-package", requirements: string[] = []) {
  const directory = join(root, id);
  await mkdir(join(directory, "dist"), { recursive: true });
  const manifest: CapabilityManifest = { id, name: id, description: "test", version: "1.0.0", protocolVersion: 1, hostApiVersion: 1,
    entries: { main: "dist/main.js", worker: "dist/worker.js", ui: "dist/ui.js" }, requirements, actions: [], navigation: { title: id, route: id, order: 1 } };
  await writeFile(join(directory, "capability.json"), JSON.stringify(manifest));
  for (const name of ["main", "worker", "ui"]) await writeFile(join(directory, `dist/${name}.js`), "export function bootstrap() {}\n");
  return directory;
}
