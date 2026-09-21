import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanCapabilities, selectCapabilities } from "../../apps/desktop/src/main/capabilities/catalog.js";
import { activateCapabilities } from "../../apps/desktop/src/main/capabilities/loader.js";
import { buildProbePackage, collectHostModuleGraphs } from "../fixtures/capabilities/probe/build.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoots: string[] = [];
const moduleMarkerKey = "__deepfieldCapabilityProbeMarkers";

function bareModuleSpecifiers(source: string): string[] {
  return [...source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined && !specifier.startsWith(".") && !specifier.startsWith("/"));
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "deepfield-capability-probe-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  Reflect.deleteProperty(globalThis, moduleMarkerKey);
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("standalone capability package build", () => {
  it("keeps scan and disabled selection free of entrypoint side effects, then activates node entries", async () => {
    const catalogRoot = await temporaryDirectory();
    const packageRoot = join(catalogRoot, "probe");
    await buildProbePackage(packageRoot);

    const marker: string[] = [];
    Reflect.set(globalThis, moduleMarkerKey, marker);
    const catalog = await scanCapabilities(catalogRoot);
    expect(catalog.issues).toEqual([]);
    expect(marker).toEqual([]);
    for (const entry of ["main", "worker"] as const) {
      const artifact = await readFile(join(packageRoot, `dist/${entry}.js`), "utf8");
      expect(bareModuleSpecifiers(artifact)).toEqual([]);
      expect(artifact).not.toContain("node_modules");
    }

    const disabled = selectCapabilities(catalog, []);
    expect(disabled).toEqual([]);
    await activateCapabilities(disabled, {
      activateMain: async () => { throw new Error("disabled main executed"); },
      activateWorker: async () => { throw new Error("disabled worker executed"); },
    });
    expect(marker).toEqual([]);

    const selected = selectCapabilities(catalog, ["probe"]);
    const result = await activateCapabilities(selected, {
      activateMain: async (entry, defer) => {
        const module = await import(pathToFileURL(join(entry.root, entry.manifest.entries.main)).href) as {
          activate(context: { record(value: string): void }, defer: (cleanup: () => void) => void): Promise<void>;
        };
        await module.activate({ record: (value) => marker.push(value) }, defer);
      },
      activateWorker: async (entry, defer) => {
        const module = await import(pathToFileURL(join(entry.root, entry.manifest.entries.worker)).href) as {
          activate(context: { record(value: string): void }, defer: (cleanup: () => void) => void): Promise<void>;
        };
        await module.activate({ record: (value) => marker.push(value) }, defer);
      },
    });

    expect(result.ready.map((entry) => entry.manifest.id)).toEqual(["probe"]);
    expect(marker).toEqual(["main:module", "main:activate", "worker:module", "worker:activate"]);
    await result.dispose();
    expect(marker).toEqual([
      "main:module",
      "main:activate",
      "worker:module",
      "worker:activate",
      "worker:cleanup",
      "main:cleanup",
    ]);
  });

  it("mounts and cleans up the independently built DOM UI entry", async () => {
    const catalogRoot = await temporaryDirectory();
    const packageRoot = join(catalogRoot, "probe");
    await buildProbePackage(packageRoot);
    const manifest = JSON.parse(await readFile(join(packageRoot, "capability.json"), "utf8")) as {
      entries: { ui: string };
    };
    const module = await import(pathToFileURL(join(packageRoot, manifest.entries.ui)).href) as {
      mount(root: Element, options: { label: string }): () => void;
    };
    const jsdomModuleName = "jsdom";
    const { JSDOM } = await import(jsdomModuleName) as {
      JSDOM: new (html: string) => { window: { document: Document } };
    };
    const document = new JSDOM("<main id='root'></main>").window.document;
    const root = document.querySelector("#root");
    if (!root) throw new Error("missing test root");

    const cleanup = module.mount(root, { label: "delivery boundary" });
    expect(root.textContent).toBe("delivery boundary");
    cleanup();
    expect(root.textContent).toBe("");
  });

  it("keeps the probe out of actual Vite host module graphs", async () => {
    const outputRoot = await temporaryDirectory();
    const graphs = await collectHostModuleGraphs(repoRoot, outputRoot);

    expect(Object.keys(graphs).sort()).toEqual(["main", "renderer", "worker"]);
    for (const modules of Object.values(graphs)) {
      expect(modules.length).toBeGreaterThan(0);
      expect(modules.some((id) => id.includes("tests/fixtures/capabilities/probe"))).toBe(false);
    }
  }, 60_000);

  it("returns an empty startup after the delivered package directory is removed", async () => {
    const catalogRoot = await temporaryDirectory();
    const packageRoot = join(catalogRoot, "probe");
    await buildProbePackage(packageRoot);
    await rm(packageRoot, { recursive: true });

    const catalog = await scanCapabilities(catalogRoot);
    const selected = selectCapabilities(catalog, ["probe"]);
    let activations = 0;
    const result = await activateCapabilities(selected, {
      activateMain: async () => { activations += 1; },
      activateWorker: async () => { activations += 1; },
    });

    expect(catalog).toEqual({ entries: [], issues: [] });
    expect(selected).toEqual([]);
    expect(result.ready).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(activations).toBe(0);
  });
});
