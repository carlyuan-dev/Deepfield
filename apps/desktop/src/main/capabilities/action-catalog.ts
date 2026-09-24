import { createHash } from "node:crypto";
import { canonicalActionJson, type CompiledActionDeclaration } from "@deepfield/capability-sdk";
import type { CatalogEntry } from "./catalog.js";
import { readPackageDocumentation } from "./package-paths.js";

export interface PublicActionEntry {
  capabilityId: string;
  actionId: string;
  packageVersion: string;
  declaration: CompiledActionDeclaration;
  documentation: string;
}
export function actionDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
export function freezeActionData<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freezeActionData(nested);
  }
  return value;
}

/** Read only package-declared paths once, before activation, and verify shipped contracts. */
export async function loadPublicActions(entry: CatalogEntry): Promise<readonly PublicActionEntry[]> {
  if (entry.manifest.protocolVersion !== 2) return [];
  const actions: PublicActionEntry[] = [];
  for (const declaration of entry.manifest.actions) {
    const documentation = await readPackageDocumentation(entry.root, declaration.documentation.path);
    const { contractDigest, ...contract } = declaration;
    if (actionDigest(documentation) !== declaration.documentation.digest || actionDigest(canonicalActionJson(contract)) !== contractDigest) {
      throw new Error("action_contract_digest_mismatch");
    }
    actions.push({ capabilityId: entry.manifest.id, actionId: declaration.id, packageVersion: entry.manifest.version, declaration: structuredClone(declaration), documentation });
  }
  return freezeActionData(actions);
}

/** Immutable startup-ready snapshot; liveness must be checked separately on every call. */
export class ActionCatalog {
  private readonly entries: readonly PublicActionEntry[];
  constructor(entries: readonly PublicActionEntry[]) { this.entries = freezeActionData(structuredClone(entries)); }
  list(): readonly PublicActionEntry[] { return this.entries; }
  find(capabilityId: string, actionId: string): PublicActionEntry | undefined {
    return this.entries.find(entry => entry.capabilityId === capabilityId && entry.actionId === actionId);
  }
}
