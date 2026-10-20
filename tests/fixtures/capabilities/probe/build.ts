import { cp, mkdir } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

export async function buildProbePackage(packageRoot: string): Promise<void> {
  const outputDirectory = join(packageRoot, "dist");
  await mkdir(outputDirectory, { recursive: true });
  await cp(join(fixtureRoot, "capability.json"), join(packageRoot, "capability.json"));

  for (const entry of ["main", "worker", "ui"] as const) {
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        emptyOutDir: false,
        lib: {
          entry: join(fixtureRoot, `${entry}.ts`),
          formats: ["es"],
          fileName: () => `${entry}.js`,
        },
        minify: false,
        outDir: outputDirectory,
        rollupOptions: { external: () => false },
      },
    });
  }
}

function moduleCollector(modules: Set<string>): Plugin {
  return {
    name: "collect-host-module-graph",
    moduleParsed(module) {
      modules.add(module.id);
    },
  };
}

function isExternalDependency(id: string): boolean {
  if (nodeBuiltins.has(id) || id === "electron") return true;
  return !id.startsWith(".") && !id.startsWith("/") && !id.startsWith("@deepfield/");
}

export async function collectHostModuleGraphs(
  repoRoot: string,
  outputRoot: string,
): Promise<Record<"main" | "worker" | "renderer", string[]>> {
  const entries = {
    main: "apps/desktop/src/main/index.ts",
    worker: "apps/desktop/src/worker/index.ts",
    renderer: "apps/desktop/src/renderer/main.tsx",
  } as const;
  const result = {} as Record<keyof typeof entries, string[]>;

  for (const [name, relativeEntry] of Object.entries(entries) as [keyof typeof entries, string][]) {
    const modules = new Set<string>();
    await build({
      configFile: false,
      logLevel: "silent",
      // Match electron.vite.config.ts: workspace package exports resolve subpaths.
      plugins: [moduleCollector(modules)],
      build: {
        emptyOutDir: true,
        lib: { entry: resolve(repoRoot, relativeEntry), formats: ["es"], fileName: () => `${name}.js` },
        minify: false,
        outDir: join(outputRoot, name),
        rollupOptions: { external: isExternalDependency },
      },
    });
    result[name] = [...modules].sort();
  }

  return result;
}
