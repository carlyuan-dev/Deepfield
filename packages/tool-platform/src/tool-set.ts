import type { ToolIdentity } from "@deepfield/contracts";
import type { ToolActor, ToolEffect } from "./definition.js";

export class ToolSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolSetError";
  }
}

export interface ToolGrant {
  readonly identity: ToolIdentity;
  readonly actor: ToolActor;
  readonly effect: ToolEffect;
  readonly projectId?: string;
  readonly hostPatterns?: readonly string[];
  readonly maxResults?: number;
  readonly maxBytes?: number;
  readonly confirmationKind?: string;
}

const TOOL_ACTORS = new Set([
  "main_agent",
  "capability",
  "child_agent",
  "direct_ui",
  "developer_probe",
] as const);

const TOOL_EFFECTS = new Set([
  "network.read.public",
  "project.read",
  "imported_file.read",
  "external.open",
  "document.write",
] as const);

function grantKey(identity: ToolIdentity): string {
  return `${identity.name}@${identity.version}`;
}

function assertValidGrant(grant: ToolGrant): void {
  if (typeof grant !== "object" || grant === null) {
    throw new ToolSetError("grant must be an object");
  }
  const identity = grant.identity as ToolIdentity | undefined;
  if (typeof identity !== "object" || identity === null) {
    throw new ToolSetError("grant identity must be an object");
  }
  if (typeof identity.name !== "string" || identity.name.trim().length === 0) {
    throw new ToolSetError("grant identity name must be a non-empty string");
  }
  if (!Number.isInteger(identity.version) || identity.version < 1) {
    throw new ToolSetError("grant identity version must be a positive integer; wildcards are not allowed");
  }
  if (!TOOL_ACTORS.has(grant.actor)) {
    throw new ToolSetError("grant actor is not a known tool actor");
  }
  if (!TOOL_EFFECTS.has(grant.effect)) {
    throw new ToolSetError("grant effect is not a known tool effect");
  }
  if (grant.projectId !== undefined && (typeof grant.projectId !== "string" || grant.projectId.trim().length === 0)) {
    throw new ToolSetError("grant projectId must be a non-empty string");
  }
  if (grant.hostPatterns !== undefined) {
    if (!Array.isArray(grant.hostPatterns) || grant.hostPatterns.some((pattern) => typeof pattern !== "string" || pattern.trim().length === 0)) {
      throw new ToolSetError("grant hostPatterns must be an array of non-empty strings");
    }
  }
  if (grant.maxResults !== undefined && (!Number.isInteger(grant.maxResults) || grant.maxResults < 1)) {
    throw new ToolSetError("grant maxResults must be a positive integer");
  }
  if (grant.maxBytes !== undefined && (!Number.isInteger(grant.maxBytes) || grant.maxBytes < 1)) {
    throw new ToolSetError("grant maxBytes must be a positive integer");
  }
  if (grant.confirmationKind !== undefined && (typeof grant.confirmationKind !== "string" || grant.confirmationKind.trim().length === 0)) {
    throw new ToolSetError("grant confirmationKind must be a non-empty string");
  }
}

function copyAndFreezeGrant(grant: ToolGrant): ToolGrant {
  const identity = Object.freeze({ name: grant.identity.name, version: grant.identity.version });
  const copy: ToolGrant = {
    identity,
    actor: grant.actor,
    effect: grant.effect,
    ...(grant.projectId !== undefined ? { projectId: grant.projectId } : {}),
    ...(grant.hostPatterns !== undefined
      ? { hostPatterns: Object.freeze([...grant.hostPatterns]) }
      : {}),
    ...(grant.maxResults !== undefined ? { maxResults: grant.maxResults } : {}),
    ...(grant.maxBytes !== undefined ? { maxBytes: grant.maxBytes } : {}),
    ...(grant.confirmationKind !== undefined ? { confirmationKind: grant.confirmationKind } : {}),
  };
  return Object.freeze(copy);
}

/** Immutable set of exact-version Tool grants; deny-by-default at policy time. */
export class ToolSet {
  readonly #grants: ReadonlyMap<string, ToolGrant>;

  constructor(grants: readonly ToolGrant[]) {
    const map = new Map<string, ToolGrant>();
    for (const grant of grants) {
      assertValidGrant(grant);
      const key = grantKey(grant.identity);
      if (map.has(key)) {
        throw new ToolSetError(`duplicate grant: ${key}`);
      }
      map.set(key, copyAndFreezeGrant(grant));
    }
    this.#grants = map;
  }

  get size(): number {
    return this.#grants.size;
  }

  has(identity: ToolIdentity): boolean {
    return this.#grants.has(grantKey(identity));
  }

  get(identity: ToolIdentity): ToolGrant | undefined {
    return this.#grants.get(grantKey(identity));
  }

  /**
   * Deterministic immutable snapshot fingerprint (grants are frozen at
   * construction, so this is stable for the lifetime of the set). Canonical
   * serialization: grants sorted by identity, fixed field order, null for
   * missing fields — no hand-rolled delimiters that could collide across
   * fields. Used by scope-bound stores to bind resources to the exact
   * authorization snapshot instead of trusting self-reported actors.
   */
  fingerprint(): string {
    const serialized: unknown[] = [];
    for (const grant of this.#grants.values()) {
      serialized.push({
        identity: { name: grant.identity.name, version: grant.identity.version },
        actor: grant.actor,
        effect: grant.effect,
        projectId: grant.projectId ?? null,
        hostPatterns: grant.hostPatterns ?? null,
        maxResults: grant.maxResults ?? null,
        maxBytes: grant.maxBytes ?? null,
        confirmationKind: grant.confirmationKind ?? null,
      });
    }
    serialized.sort((a, b) => {
      const left = a as { identity: { name: string; version: number } };
      const right = b as { identity: { name: string; version: number } };
      return (
        left.identity.name.localeCompare(right.identity.name) ||
        left.identity.version - right.identity.version
      );
    });
    return JSON.stringify(serialized);
  }
}
