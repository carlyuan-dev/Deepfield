import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { resolvePackageFile } from "../main/capabilities/package-paths.js";
import type { CapabilityHostServices, CapabilityRegistrar, CapabilityWorkerRegistrar } from "@deepfield/capability-sdk";

export interface TrustedCapabilityEntry { readonly id: string; readonly root: string; readonly main: string; readonly worker?: string }
export interface CapabilityEntryModule { bootstrap(registrar: CapabilityRegistrar | CapabilityWorkerRegistrar, services: CapabilityHostServices): void | Promise<void> }
export async function loadCapabilityEntry(entry: TrustedCapabilityEntry, kind: "main" | "worker"): Promise<CapabilityEntryModule> {
  const entryPath = entry[kind];
  if (!entryPath) throw new Error("capability_entry_unavailable");
  const resolved = await resolvePackageFile(entry.root, entryPath);
  if (!resolved || resolved !== resolve(entry.root, entryPath)) throw new Error("capability_entry_unavailable");
  const module: unknown = await import(/* @vite-ignore */ pathToFileURL(resolved).href);
  if (!module || typeof module !== "object" || typeof (module as CapabilityEntryModule).bootstrap !== "function") throw new Error("invalid_capability_entry");
  return module as CapabilityEntryModule;
}

export function createSnapshotWorkerLoader(snapshot: readonly TrustedCapabilityEntry[], services: CapabilityHostServices,
  load = loadCapabilityEntry) {
  const entries = new Map(snapshot.map(entry => [entry.id, Object.freeze({ ...entry })]));
  return async (request: { capabilityId: string; entry: string }, registrar: CapabilityWorkerRegistrar) => {
    const entry = entries.get(request.capabilityId);
    if (!entry?.worker) throw new Error("capability_unavailable");
    const resolved = await resolvePackageFile(entry.root, entry.worker);
    if (!resolved || resolved !== resolve(entry.root, entry.worker) || request.entry !== resolved) throw new Error("capability_unavailable");
    await (await load(entry, "worker")).bootstrap(registrar, services);
  };
}
