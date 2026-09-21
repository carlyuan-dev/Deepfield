import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const MAX_MANIFEST_BYTES = 256 * 1024;

export interface ManifestFileSystem {
  stat(path: string): Promise<{ size: number }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export interface PackagePathFileSystem {
  stat(path: string): Promise<unknown>;
  realpath(path: string): Promise<string>;
}

export type ManifestFileResult =
  | { ok: true; text: string }
  | { ok: false; code: "manifest_too_large" | "manifest_read_failed" };

export type PackagePathsResult =
  | { ok: true }
  | { ok: false; code: "invalid_path" | "entry_missing" | "documentation_missing" | "path_outside_package" };

const defaultManifestFileSystem: ManifestFileSystem = { stat, readFile };
const defaultPackagePathFileSystem: PackagePathFileSystem = { stat, realpath };

export async function readManifestFile(
  path: string,
  fileSystem: ManifestFileSystem = defaultManifestFileSystem,
): Promise<ManifestFileResult> {
  try {
    const metadata = await fileSystem.stat(path);
    if (metadata.size > MAX_MANIFEST_BYTES) return { ok: false, code: "manifest_too_large" };
    return { ok: true, text: await fileSystem.readFile(path, "utf8") };
  } catch {
    return { ok: false, code: "manifest_read_failed" };
  }
}

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.startsWith("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return false;
  return !path.split(/[\\/]/).includes("..");
}

function isContained(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

/** Resolve and return the canonical regular file, never a path containing a symlink. */
export async function resolvePackageFile(packageRoot: string, path: string): Promise<string | undefined> {
  if (!isSafeRelativePath(path)) return undefined;
  try {
    const root = await realpath(packageRoot);
    const candidate = await realpath(resolve(root, path));
    if (!isContained(root, candidate) || !(await stat(candidate)).isFile()) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

export async function validatePackagePaths(
  packageRoot: string,
  paths: {
    entries: { main: string; worker: string; ui?: string };
    documentationPaths: readonly string[];
  },
  fileSystem: PackagePathFileSystem = defaultPackagePathFileSystem,
): Promise<PackagePathsResult> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await fileSystem.realpath(packageRoot);
  } catch {
    return { ok: false, code: "invalid_path" };
  }

  const candidates = [
    ...Object.values(paths.entries).map((path) => ({ path, missingCode: "entry_missing" as const })),
    ...paths.documentationPaths.map((path) => ({ path, missingCode: "documentation_missing" as const })),
  ];

  for (const candidate of candidates) {
    if (!isSafeRelativePath(candidate.path)) return { ok: false, code: "invalid_path" };
    const absolutePath = resolve(packageRoot, candidate.path);
    try {
      await fileSystem.stat(absolutePath);
    } catch {
      return { ok: false, code: candidate.missingCode };
    }
    let canonicalPath: string;
    try {
      canonicalPath = await fileSystem.realpath(absolutePath);
    } catch {
      return { ok: false, code: candidate.missingCode };
    }
    if (!isContained(canonicalRoot, canonicalPath)) return { ok: false, code: "path_outside_package" };
  }

  return { ok: true };
}
