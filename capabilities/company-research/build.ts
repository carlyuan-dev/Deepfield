import { builtinModules } from "node:module";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { buildCapabilityUi } from "../../scripts/capabilities/build-ui.ts";
import { compileActionCatalog, verifyBuiltActionCatalog } from "../../scripts/capabilities/build-actions.ts";

const root = dirname(fileURLToPath(import.meta.url));
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

/** Portable ESM artifacts: only Node built-ins remain external. */
export async function buildPackage(outDir: string): Promise<void> {
  await mkdir(join(outDir, "dist"), { recursive: true });
  await writeFile(join(outDir, "package.json"), JSON.stringify({ name: "deepfield-capability-company-research", private: true, type: "module" }) + "\n");
  let declarations: import("@deepfield/capability-sdk").CompiledActionDeclaration[] = [];
  let views: unknown[] = [];
  for (const entry of ["main", "main", "worker"]) {
    await build({
      configFile: false, logLevel: "warn",
      define: { __COMPANY_ACTION_DECLARATIONS__: JSON.stringify(declarations) },
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
    if (entry === "main" && declarations.length === 0) {
      const metadata = await import(`${pathToFileURL(join(outDir, "dist/main.js")).href}?metadata=${Date.now()}`);
      declarations = await compileActionCatalog({ capabilityRoot: root, actions: metadata.createActionDefinitions() });
      views = metadata.viewDeclarations;
    }
  }
  await buildCapabilityUi({ entry: join(root, "ui/package-ui.tsx"), css: join(root, "ui/capability.css"), capabilityId: "company-research", outDir: join(outDir, "dist") });
  const manifest = JSON.parse(await readFile(join(root, "capability.json"), "utf8"));
  await writeFile(join(outDir, "capability.json"), JSON.stringify({ ...manifest, actions: declarations, views }, null, 2) + "\n");
  await mkdir(join(outDir, "docs/actions"), { recursive: true });
  for (const action of declarations) await copyFile(join(root, action.documentation.path), join(outDir, action.documentation.path));
  if (manifest.help) await copyFile(join(root, manifest.help), join(outDir, manifest.help));
  await verifyBuiltActionCatalog(outDir);
}
