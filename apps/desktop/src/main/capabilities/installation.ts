import { cp, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { scanCapabilities } from "./catalog.js";
import { readCapabilityPreferences, writeCapabilityPreferences } from "./preferences.js";

export interface CapabilityPaths { scanRoot: string; bundledRoot: string; statePath: string }
export function capabilityPaths(options: { userDataRoot: string; appPath: string; resourcesPath: string; isPackaged: boolean }): CapabilityPaths {
  return { scanRoot: join(options.userDataRoot, "capabilities"), statePath: join(options.userDataRoot, "capabilities-state.json"),
    bundledRoot: options.isPackaged ? join(options.resourcesPath, "capabilities") : join(options.appPath, "out/capabilities") };
}
export async function initializeCapabilities(paths: CapabilityPaths): Promise<void> {
  const remainder = relative(paths.scanRoot, paths.statePath);
  if (!isAbsolute(remainder) && !remainder.startsWith("..")) throw new Error("state_must_be_outside_scan_root");
  const previous = await readCapabilityPreferences(paths.statePath);
  if (previous?.initialized) return;
  const bundled = await scanCapabilities(paths.bundledRoot);
  if (bundled.issues.length) throw new Error("bundled_capability_invalid");
  // Missing build artifacts are a valid package-free startup, not a completed install.
  if (bundled.entries.length === 0) return;
  await mkdir(dirname(paths.scanRoot), { recursive: true });
  const enabledIds = new Set(previous?.enabledIds ?? []);
  for (const entry of bundled.entries) {
    const target = join(paths.scanRoot, basename(entry.root));
    try { await lstat(target); continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // Record intent before publication so a crash after rename retains its default selection.
    enabledIds.add(entry.manifest.id);
    await writeCapabilityPreferences(paths.statePath, { schemaVersion: 1, initialized: false, enabledIds: [...enabledIds] });
    // Staging is a sibling of scanRoot: a crashed copy can never be scanned as ready.
    const stage = await mkdtemp(join(dirname(paths.scanRoot), ".capability-install-"));
    try {
      const stagedPackage = join(stage, basename(entry.root));
      await cp(entry.root, stagedPackage, { recursive: true, dereference: true, errorOnExist: true, force: false });
      const verified = await scanCapabilities(stage);
      if (verified.issues.length || verified.entries.length !== 1) throw new Error("capability_copy_invalid");
      await mkdir(paths.scanRoot, { recursive: true });
      await rename(stagedPackage, target);
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  await writeCapabilityPreferences(paths.statePath, { schemaVersion: 1, initialized: true, enabledIds: [...enabledIds] });
}
