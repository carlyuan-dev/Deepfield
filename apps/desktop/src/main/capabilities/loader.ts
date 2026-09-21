import { basename } from "node:path";
import {
  createResourceScope,
  type Cleanup,
  type ResourceScope,
} from "@deepfield/capability-sdk";
import type { CatalogEntry, CatalogIssue } from "./catalog.js";

export interface ActivationAdapter {
  activateMain(entry: CatalogEntry, defer: (cleanup: Cleanup) => void): Promise<void>;
  activateWorker(entry: CatalogEntry, defer: (cleanup: Cleanup) => void): Promise<void>;
}

export interface ActivationResult {
  readonly ready: readonly CatalogEntry[];
  readonly issues: readonly CatalogIssue[];
  dispose(): Promise<void>;
}

interface PackageScope {
  readonly packageName: string;
  readonly scope: ResourceScope;
}

export async function activateCapabilities(
  selected: readonly CatalogEntry[],
  adapter: ActivationAdapter,
): Promise<ActivationResult> {
  const ready: CatalogEntry[] = [];
  const activationIssues: CatalogIssue[] = [];
  const packageScopes: PackageScope[] = [];
  const activeScope = createResourceScope();

  for (const entry of selected) {
    const packageName = basename(entry.root);
    const scope = createResourceScope();
    packageScopes.push({ packageName, scope });
    try {
      await adapter.activateMain(entry, scope.defer);
      await adapter.activateWorker(entry, scope.defer);
      ready.push(entry);
      activeScope.defer(() => scope.dispose());
    } catch {
      activationIssues.push({ packageName, code: "activation_failed" });
      await scope.dispose();
    }
  }

  const readySnapshot = Object.freeze([...ready]);
  return {
    ready: readySnapshot,
    get issues() {
      const cleanupIssues = packageScopes.flatMap(({ packageName, scope }) =>
        scope.issues.map(({ code }) => ({ packageName, code })),
      );
      return Object.freeze([
        ...activationIssues.map((issue) => ({ ...issue })),
        ...cleanupIssues,
      ]);
    },
    dispose: () => activeScope.dispose(),
  };
}
