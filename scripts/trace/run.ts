import { builtinModules } from "node:module";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "vite";

// Application source uses NodeNext .js imports. Compile its transitive graph
// using the same Vite SSR facility as the capability build before Node runs it.
const [command, ...args] = process.argv.slice(2);
if (command !== "export" && command !== "phoenix") {
  console.error("Usage: node scripts/trace/run.ts <export|phoenix> [...arguments]");
  process.exitCode = 1;
} else {
  const directory = await mkdtemp(join(tmpdir(), "deepfield-trace-cli-"));
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  try {
    await build({
      configFile: false, logLevel: "error", ssr: { noExternal: true },
      build: {
        ssr: fileURLToPath(new URL(`./${command}.ts`, import.meta.url)),
        target: "node24", outDir: directory, emptyOutDir: false, minify: false,
        rollupOptions: {
          external: id => builtins.has(id),
          // Separate chunks preserve import.meta.url entry guards when Phoenix
          // imports export: importing a library never invokes that library CLI.
          output: { format: "es", entryFileNames: `${command}.mjs`, chunkFileNames: "[name]-[hash].mjs" },
        },
      },
    });
    // macOS tmpdir can use /var -> /private/var; match Node's canonical module
    // URL so the CLI entry guard sees the same path as process.argv[1].
    const entry = await realpath(join(directory, `${command}.mjs`));
    const child = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit" });
    if (child.error || child.signal) throw new Error("trace_cli_process_failed");
    process.exitCode = child.status ?? 1;
  } catch {
    console.error("trace_cli_failed: check the local build dependencies and entrypoint");
    process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
