import { builtinModules } from "node:module";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { compileActionCatalog, verifyBuiltActionCatalog } from "../../../scripts/capabilities/build-actions.js";
import type { CompiledActionDeclaration } from "@deepfield/capability-sdk";

const root = dirname(fileURLToPath(import.meta.url));
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));

/** Build a portable main-only package; no install-time TypeScript compilation is needed. */
export async function buildPackage(outDir: string): Promise<void> {
  await mkdir(join(outDir, "dist"), { recursive: true });
  await writeFile(join(outDir, "package.json"), JSON.stringify({ name: "deepfield-capability-record-lookup", private: true, type: "module" }) + "\n");
  let declarations: CompiledActionDeclaration[] = [];
  for (let pass = 0; pass < 2; pass++) {
    await build({
      configFile: false,
      logLevel: "warn",
      define: { __RECORD_LOOKUP_ACTION_DECLARATIONS__: JSON.stringify(declarations) },
      ssr: { noExternal: true },
      build: {
        ssr: join(root, "main.ts"),
        target: "node24",
        outDir: join(outDir, "dist"),
        emptyOutDir: false,
        minify: false,
        rollupOptions: {
          external: id => builtins.has(id),
          output: { format: "es", entryFileNames: "main.js", inlineDynamicImports: true },
          plugins: [{ name: "portable-record-lookup-externals", generateBundle() {
            for (const id of this.getModuleIds()) {
              if (this.getModuleInfo(id)?.isExternal && !builtins.has(id)) throw new Error(`Unsupported package external: ${id}`);
            }
          } }],
        },
      },
    });
    if (pass === 0) {
      const metadata = await import(`${pathToFileURL(join(outDir, "dist/main.js")).href}?metadata=${Date.now()}`) as {
        createActionDefinitions(): import("@deepfield/capability-sdk").ActionDefinition[];
      };
      declarations = await compileActionCatalog({ capabilityRoot: root, actions: metadata.createActionDefinitions() });
    }
  }
  const manifest = JSON.parse(await readFile(join(root, "capability.json"), "utf8"));
  await writeFile(join(outDir, "capability.json"), JSON.stringify({ ...manifest, actions: declarations }, null, 2) + "\n");
  for (const declaration of declarations) {
    const destination = join(outDir, declaration.documentation.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, declaration.documentation.path), destination);
  }
  await verifyBuiltActionCatalog(outDir);
}
