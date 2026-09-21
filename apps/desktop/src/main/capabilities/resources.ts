import { realpath } from "node:fs/promises";
import { extname } from "node:path";
import { resolvePackageFile } from "./package-paths.js";

export interface CapabilityResourcePackage {
  readonly id: string;
  readonly root: string;
  readonly state: string;
}

export interface CapabilityResource {
  path: string;
  mimeType: string;
}

const mimeTypes: Readonly<Record<string, string>> = {
  ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".woff2": "font/woff2",
};

/** Same URL resolver for development and packaged apps; no Vite server or Electron dependency. */
export async function createCapabilityResourceResolver(snapshot: readonly CapabilityResourcePackage[]) {
  const roots = new Map<string, string>();
  const duplicateIds = new Set(snapshot.filter((entry, i) => snapshot.findIndex(other => other.id === entry.id) !== i).map(entry => entry.id));
  for (const entry of snapshot) {
    if (entry.state !== "ready" || duplicateIds.has(entry.id) || !/^[a-z][a-z0-9-]*$/.test(entry.id)) continue;
    try { roots.set(entry.id, await realpath(entry.root)); } catch { /* A removed package has no resources. */ }
  }
  return async (request: { method: string; url: string }): Promise<CapabilityResource | undefined> => {
    if (request.method !== "GET") return undefined;
    // Inspect raw path before URL parsing can erase dot segments.
    const match = /^deepfield-capability:\/\/([a-z][a-z0-9-]*)\/([^?#]+)$/.exec(request.url);
    if (!match) return undefined;
    const root = roots.get(match[1]!);
    if (!root) return undefined;
    let relativePath: string;
    try { relativePath = decodeURIComponent(match[2]!); } catch { return undefined; }
    if (/[\\%\u0000]/.test(relativePath)) return undefined;
    const mimeType = mimeTypes[extname(relativePath)];
    if (!mimeType) return undefined;
    const path = await resolvePackageFile(root, relativePath);
    return path ? { path, mimeType } : undefined;
  };
}
