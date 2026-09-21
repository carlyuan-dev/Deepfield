import { builtinModules } from "node:module";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { buildCapabilityUi } from "../../scripts/capabilities/build-ui.ts";

const root = dirname(fileURLToPath(import.meta.url));
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

/** Portable ESM artifacts: only Node built-ins remain external. */
export async function buildPackage(outDir: string): Promise<void> {
  await mkdir(join(outDir, "dist"), { recursive: true });
  for (const entry of ["main", "worker"]) {
    await build({
      configFile: false, logLevel: "warn",
      ssr: { noExternal: true },
      build: {
        ssr: join(root, `${entry}.ts`), target: "node24", outDir: join(outDir, "dist"),
        emptyOutDir: false, minify: false,
        rollupOptions: {
          external: id => builtins.has(id),
          output: { format: "es", entryFileNames: `${entry}.js`, inlineDynamicImports: true },
          plugins: [{ name: "portable-capability-externals", generateBundle() {
            for (const id of this.getModuleIds()) {
              if (this.getModuleInfo(id)?.isExternal && !builtins.has(id)) throw new Error(`Unsupported package external: ${id}`);
            }
          } }],
        },
      },
    });
  }
  await buildCapabilityUi({ entry: join(root, "ui/package-ui.tsx"), css: join(root, "ui/capability.css"), capabilityId: "company-research", outDir: join(outDir, "dist") });
  await copyFile(join(root, "capability.json"), join(outDir, "capability.json"));
  await writeFile(join(outDir, "package.json"), JSON.stringify({ name: "deepfield-capability-company-research", private: true, type: "module" }) + "\n");
}
