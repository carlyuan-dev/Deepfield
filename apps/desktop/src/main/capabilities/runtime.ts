import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import type { CapabilityHostServices } from "@deepfield/capability-sdk";
import type { AgentWorkerClient } from "../agent-worker-client.js";
import { loadCapabilityEntry, type TrustedCapabilityEntry } from "../../shared/capability-entry.js";
import { scanCapabilities, selectCapabilities, type CatalogEntry, type CatalogIssue } from "./catalog.js";
import { initializeCapabilities, type CapabilityPaths } from "./installation.js";
import { readEnabledIds, writeEnabledIds } from "./preferences.js";
import { resolvePackageFile } from "./package-paths.js";
import { activateRegisteredCapability, CapabilityRegistry, type CapabilityActivation } from "./registry.js";

export interface CapabilityStatus {
  id: string; name: string; description: string; version: string;
  status: "disabled" | "loading" | "ready" | "incompatible" | "failed";
  enabledNextStart: boolean;
  issue?: string;
  navigation?: { title: string; order: number; route: string };
  uiEntry?: string;
}
export async function prepareCapabilities(paths: CapabilityPaths) {
  const issues: CatalogIssue[] = [];
  let enabled: readonly string[] = [];
  try { await initializeCapabilities(paths); enabled = await readEnabledIds(paths.statePath); }
  catch { issues.push({ packageName: ".", code: "capability_state_unavailable" }); }
  const catalog = await scanCapabilities(paths.scanRoot);
  issues.push(...catalog.issues);
  const selected = selectCapabilities(catalog, enabled);
  const workerSnapshot: readonly TrustedCapabilityEntry[] = Object.freeze(await Promise.all(selected.map(async entry => {
    const main = await resolvePackageFile(entry.root, entry.manifest.entries.main);
    const worker = await resolvePackageFile(entry.root, entry.manifest.entries.worker);
    return Object.freeze({ id: entry.manifest.id, root: entry.root,
      main: main ? relative(entry.root, main) : entry.manifest.entries.main,
      worker: worker ? relative(entry.root, worker) : entry.manifest.entries.worker });
  })));
  return { paths, catalog, selected, workerSnapshot, enabled, issues };
}
export type PreparedCapabilities = Awaited<ReturnType<typeof prepareCapabilities>>;

export function createCapabilityRuntime(prepared: PreparedCapabilities, registry: CapabilityRegistry, load = loadCapabilityEntry) {
  let enabled = new Set(prepared.enabled);
  const states = new Map<string, { status: CapabilityStatus["status"]; issue?: string }>();
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) { try { listener(); } catch { /* isolated subscriber */ } } };
  let writeQueue = Promise.resolve();
  let unsubscribeWorker: (() => void) | undefined;
  let disposed = false;
  let generation = 0;
  const activations = new Set<CapabilityActivation>();
  const disposals = new Set<Promise<void>>();
  const disposeActivations = async () => {
    for (const activation of activations) {
      const pending = activation.dispose();
      disposals.add(pending);
      void pending.then(() => disposals.delete(pending));
    }
    activations.clear(); await Promise.all(disposals);
  };
  for (const entry of prepared.catalog.entries) states.set(entry.manifest.id, { status: prepared.enabled.includes(entry.manifest.id) ? "loading" : "disabled" });
  const readyEntries = (): readonly CatalogEntry[] => prepared.selected.filter(entry => registry.readyIds().includes(entry.manifest.id));
  return {
    issues: prepared.issues,
    workerSnapshot: prepared.workerSnapshot,
    readyEntries,
    list(): CapabilityStatus[] {
      return prepared.catalog.entries.map(({ manifest }) => {
        const status = states.get(manifest.id)!;
        const ready = status.status === "ready" && registry.readyIds().includes(manifest.id);
        return { id: manifest.id, name: manifest.name, description: manifest.description, version: manifest.version,
          ...status, status: status.status === "ready" && !ready ? "failed" : status.status,
          enabledNextStart: enabled.has(manifest.id),
          ...(ready && manifest.navigation ? { navigation: { ...manifest.navigation } } : {}),
          ...(ready && manifest.entries.ui ? { uiEntry: `deepfield-capability://${manifest.id}/${manifest.entries.ui}` } : {}),
        };
      });
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setEnabled(id: string, value: boolean): Promise<void> {
      if (!states.has(id) || typeof value !== "boolean") return Promise.reject(new Error("invalid_capability_id"));
      const write = writeQueue.then(async () => {
        const next = new Set(enabled); if (value) next.add(id); else next.delete(id);
        await writeEnabledIds(prepared.paths.statePath, [...next]); enabled = next; changed();
      });
      writeQueue = write.catch(() => {});
      return write;
    },
    async start(client: Pick<AgentWorkerClient, "activateCapability" | "deactivateCapability" | "subscribeUnavailable">, services: CapabilityHostServices) {
      if (disposed) throw new Error("capability_runtime_disposed");
      const currentGeneration = ++generation;
      const assertCurrent = () => { if (disposed || generation !== currentGeneration) throw new Error("capability_start_interrupted"); };
      unsubscribeWorker?.();
      // Recreating a Worker reuses prepared.selected; next-start preferences never enter here.
      await disposeActivations();
      if (disposed || generation !== currentGeneration) return;
      unsubscribeWorker = client.subscribeUnavailable(() => {
        if (generation !== currentGeneration) return;
        generation++;
        for (const entry of prepared.selected) states.set(entry.manifest.id, { status: "failed", issue: "worker_unavailable" });
        void disposeActivations(); changed();
      });
      for (const entry of prepared.selected) {
        if (disposed || generation !== currentGeneration) break;
        const id = entry.manifest.id;
        states.set(id, { status: "loading" }); changed();
        try {
          if (entry.manifest.requirements.some(name => !services.has(name))) throw new Error("missing_host_service");
          const trusted = prepared.workerSnapshot.find(candidate => candidate.id === id)!;
          const workerEntry = await resolvePackageFile(entry.root, entry.manifest.entries.worker);
          assertCurrent();
          if (!workerEntry) throw new Error("entry_missing");
          const activation = await activateRegisteredCapability({ registry, capabilityId: id,
            activateMain: async registrar => {
              const module = await load(trusted, "main");
              assertCurrent();
              await module.bootstrap(registrar, services);
            },
            activateWorker: () => { assertCurrent(); return client.activateCapability(id, workerEntry, randomUUID()); },
            deactivateWorker: () => client.deactivateCapability(id),
            onWorkerUnavailable: listener => client.subscribeUnavailable(listener),
          });
          if (disposed || generation !== currentGeneration) { await activation.dispose(); break; }
          activations.add(activation);
          states.set(id, { status: "ready" });
        } catch (error) {
          if (disposed || generation !== currentGeneration) break;
          const missing = error instanceof Error && error.message === "missing_host_service";
          states.set(id, { status: missing ? "incompatible" : "failed", issue: missing ? "missing_host_service" : "activation_failed" });
        }
        changed();
      }
    },
    async dispose() {
      disposed = true; generation++; unsubscribeWorker?.();
      for (const entry of prepared.selected) states.set(entry.manifest.id, { status: "failed", issue: "runtime_disposed" });
      await disposeActivations(); await registry.dispose(); changed(); listeners.clear();
    },
  };
}
export type CapabilityRuntime = ReturnType<typeof createCapabilityRuntime>;
