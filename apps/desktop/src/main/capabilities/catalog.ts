import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { validateManifest, type CapabilityManifest } from "@deepfield/capability-sdk";
import { readManifestFile, validatePackagePaths } from "./package-paths.js";

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
}

export interface CapabilityFileSystem {
  readdir(path: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>;
  stat(path: string): Promise<{ size: number }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  realpath(path: string): Promise<string>;
}

export interface CatalogEntry {
  root: string;
  manifest: CapabilityManifest;
}

export interface CatalogIssue {
  packageName: string;
  code: string;
}

export interface Catalog {
  entries: CatalogEntry[];
  issues: CatalogIssue[];
}

const defaultFileSystem: CapabilityFileSystem = { readdir, stat, readFile, realpath };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function contained(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

export async function scanCapabilities(
  root: string,
  fileSystem: CapabilityFileSystem = defaultFileSystem,
): Promise<Catalog> {
  let directories: DirectoryEntry[];
  try {
    directories = await fileSystem.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { entries: [], issues: [] };
    return { entries: [], issues: [{ packageName: ".", code: "scan_failed" }] };
  }

  const entries: CatalogEntry[] = [];
  const issues: CatalogIssue[] = [];
  for (const directory of directories.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const packageRoot = join(root, directory.name);
    const manifestPath = join(packageRoot, "capability.json");
    let canonicalRoot: string;
    let canonicalManifest: string;
    try {
      [canonicalRoot, canonicalManifest] = await Promise.all([
        fileSystem.realpath(packageRoot),
        fileSystem.realpath(manifestPath),
      ]);
      if (!contained(canonicalRoot, canonicalManifest)) {
        issues.push({ packageName: directory.name, code: "path_outside_package" });
        continue;
      }
    } catch (error) {
      issues.push({ packageName: directory.name, code: errorCode(error) === "ENOENT" ? "manifest_missing" : "scan_failed" });
      continue;
    }

    const file = await readManifestFile(canonicalManifest, fileSystem);
    if (!file.ok) {
      issues.push({ packageName: directory.name, code: file.code });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      issues.push({ packageName: directory.name, code: "invalid_manifest" });
      continue;
    }
    const validation = validateManifest(parsed);
    if (!validation.ok) {
      issues.push({ packageName: directory.name, code: validation.code });
      continue;
    }

    const pathValidation = await validatePackagePaths(canonicalRoot, {
      entries: validation.manifest.entries,
      documentationPaths: validation.manifest.actions.map((action) => action.documentation.path),
    }, fileSystem);
    if (!pathValidation.ok) {
      issues.push({ packageName: directory.name, code: pathValidation.code });
      continue;
    }
    entries.push({ root: canonicalRoot, manifest: validation.manifest });
  }

  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.manifest.id, (counts.get(entry.manifest.id) ?? 0) + 1);
  const uniqueEntries = entries.filter((entry) => {
    if (counts.get(entry.manifest.id) === 1) return true;
    issues.push({ packageName: packageName(entry.root), code: "duplicate_id" });
    return false;
  });
  issues.sort((a, b) => a.packageName.localeCompare(b.packageName));
  return { entries: uniqueEntries, issues };
}

function packageName(root: string): string {
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) ?? root;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function selectCapabilities(catalog: Catalog, enabledIds: readonly string[]): readonly CatalogEntry[] {
  const enabled = new Set(enabledIds);
  const snapshot = catalog.entries
    .filter((entry) => enabled.has(entry.manifest.id))
    .map((entry) => structuredClone(entry));
  return deepFreeze(snapshot);
}
