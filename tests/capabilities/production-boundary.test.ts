import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, readdir, rm, symlink, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, expect, it } from "vitest";

const exec = promisify(execFile);
const roots: string[] = [];
async function temporary() { const root = await mkdtemp(join(tmpdir(), "deepfield-production-")); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function productionGraph(cwd: string, outDir: string) {
  const result = await exec(process.execPath, ["--input-type=module", "-e", `
    import {build} from 'electron-vite';
    const graphs=[];
    await build({logLevel:'silent',build:{outDir:${JSON.stringify(outDir)}},plugins:[{
      name:'production-boundary-evidence',generateBundle(options,bundle) {
        graphs.push({entries:Object.values(bundle).filter(x=>x.type==='chunk'&&x.isEntry).map(x=>x.name),modules:[...this.getModuleIds()]});
      }
    }]});
    console.log(JSON.stringify(graphs));
  `], { cwd, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { entries: string[]; modules: string[] }[];
}

it("excludes company research from the actual production main/worker/preload/renderer graphs", async () => {
  const graphs = await productionGraph(resolve("."), join(await temporary(), "out"));
  expect(graphs).toHaveLength(3);
  expect(graphs.flatMap(graph => graph.entries)).toEqual(expect.arrayContaining(["index", "agent-worker"]));
  expect(graphs.flatMap(graph => graph.entries)).not.toContain("profile-diagnose-cli");
  for (const graph of graphs) {
    expect(graph.modules.length).toBeGreaterThan(0);
    expect(graph.modules.filter(id => id.includes("/capabilities/company-research/"))).toEqual([]);
  }
}, 60_000);

it("builds the host with capabilities sources absent and skips package construction without restoring them", async () => {
  const fixture = await temporary();
  for (const path of ["apps", "packages", "scripts/capabilities", "electron.vite.config.ts", "package.json", "tsconfig.base.json"]) {
    await cp(resolve(path), join(fixture, path), { recursive: true, filter: source => !source.includes("/node_modules/") && !source.endsWith("/node_modules") });
  }
  await mkdir(join(fixture, "node_modules/@deepfield"), { recursive: true });
  for (const name of await readdir("node_modules")) {
    if (name !== "@deepfield") await symlink(resolve("node_modules", name), join(fixture, "node_modules", name));
  }
  for (const name of await readdir("node_modules/@deepfield")) {
    const original = await readFile(resolve("node_modules/@deepfield", name, "package.json"), "utf8");
    const candidates = await readdir(join(fixture, "packages"));
    for (const candidate of candidates) {
      const manifest = await readFile(join(fixture, "packages", candidate, "package.json"), "utf8").catch(() => "{}");
      if (JSON.parse(manifest).name === JSON.parse(original).name) await symlink(join(fixture, "packages", candidate), join(fixture, "node_modules/@deepfield", name));
    }
  }
  const graphs = await productionGraph(fixture, join(fixture, "out"));
  expect(graphs.flatMap(graph => graph.modules).filter(id => id.includes("/capabilities/company-research/"))).toEqual([]);
  expect(graphs.flatMap(graph => graph.modules).filter(id => id.startsWith(resolve("packages") + "/"))).toEqual([]);
  await mkdir(join(fixture, "out/capabilities/stale-package"), { recursive: true });
  await writeFile(join(fixture, "out/capabilities/stale-package/capability.json"), "{}");
  await exec(process.execPath, ["scripts/capabilities/build.ts"], { cwd: fixture });
  expect(await readdir(join(fixture, "out/capabilities"))).toEqual([]);
  expect(await readdir(fixture)).not.toContain("capabilities");
}, 60_000);
