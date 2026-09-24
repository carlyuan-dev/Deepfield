import type { TSchema } from "typebox";
import { Clone } from "typebox/value";
import type { ToolManifestEntry } from "@deepfield/contracts";
import type { ToolDefinition, ToolMeterCategory } from "./definition.js";

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

interface ToolIdentityLike {
  name: string;
  version: number;
}

const TOOL_EFFECTS = new Set([
  "network.read.public",
  "system.read",
  "local.compute",
  "conversation.read",
  "project.read",
  "imported_file.read",
  "external.open",
  "document.write",
] as const);

const METER_CATEGORIES = new Set(["search", "fetch", "link_check", "parse", "none"] as const);

function identityKey(identity: ToolIdentityLike): string {
  return `${identity.name}@${identity.version}`;
}

/**
 * Real TypeBox schemas carry a non-enumerable `~kind` marker (the same marker
 * TypeBox's own `IsKind` reads). Plain JSON look-alikes and naive
 * JSON.stringify/parse round-trips lose it and are rejected.
 */
function isTypeBoxSchema(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<PropertyKey, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(record, "~kind") &&
    !Object.prototype.propertyIsEnumerable.call(record, "~kind") &&
    typeof record["~kind"] === "string"
  );
}

function assertValidDefinition(definition: unknown): asserts definition is ToolDefinition<any, any> {
  if (typeof definition !== "object" || definition === null) {
    throw new ToolRegistryError("tool definition must be an object");
  }
  const d = definition as ToolDefinition<any, any>;
  const rawIdentity = (d as { identity?: unknown }).identity;
  if (typeof rawIdentity !== "object" || rawIdentity === null) {
    throw new ToolRegistryError("tool definition identity must be an object");
  }
  const identity = rawIdentity as ToolIdentityLike;
  if (typeof identity.name !== "string" || identity.name.trim().length === 0) {
    throw new ToolRegistryError("tool definition name must be a non-empty string");
  }
  if (!Number.isInteger(identity.version) || identity.version < 1) {
    throw new ToolRegistryError("tool definition version must be a positive integer");
  }
  const key = identityKey(identity);
  if (typeof d.label !== "string" || d.label.trim().length === 0) {
    throw new ToolRegistryError(`tool ${key} label must be a non-empty string`);
  }
  if (typeof d.description !== "string" || d.description.trim().length === 0) {
    throw new ToolRegistryError(`tool ${key} description must be a non-empty string`);
  }
  if (d.userFacing !== undefined &&
    (typeof d.userFacing !== "object" || d.userFacing === null
      || typeof d.userFacing.name !== "string" || !d.userFacing.name.trim()
      || typeof d.userFacing.description !== "string" || !d.userFacing.description.trim())) {
    throw new ToolRegistryError(`tool ${key} userFacing copy must contain a name and description`);
  }
  if (!TOOL_EFFECTS.has(d.effect)) {
    throw new ToolRegistryError(`tool ${key} has unknown effect`);
  }
  if (!Number.isInteger(d.timeoutMs) || d.timeoutMs < 1) {
    throw new ToolRegistryError(`tool ${key} timeoutMs must be a positive integer`);
  }
  if (typeof d.retry !== "object" || d.retry === null) {
    throw new ToolRegistryError(`tool ${key} retry must be an object`);
  }
  const retry = d.retry as { maxRetries?: unknown; backoffMs?: unknown };
  if (typeof retry.maxRetries !== "number" || ![0, 1, 2].includes(retry.maxRetries)) {
    throw new ToolRegistryError(`tool ${key} retry.maxRetries must be 0, 1 or 2`);
  }
  if (
    typeof retry.backoffMs !== "number" ||
    !Number.isInteger(retry.backoffMs) ||
    retry.backoffMs < 0
  ) {
    throw new ToolRegistryError(`tool ${key} retry.backoffMs must be a non-negative integer`);
  }
  if (!Number.isInteger(d.concurrency) || d.concurrency < 1) {
    throw new ToolRegistryError(`tool ${key} concurrency must be a positive integer`);
  }
  if (typeof d.meter !== "object" || d.meter === null) {
    throw new ToolRegistryError(`tool ${key} meter must be an object`);
  }
  const meter = d.meter as { category?: unknown; countsBytes?: unknown; countsTime?: unknown; commitOn?: unknown };
  if (typeof meter.category !== "string" || !METER_CATEGORIES.has(meter.category as ToolMeterCategory)) {
    throw new ToolRegistryError(`tool ${key} has unknown meter category`);
  }
  if (typeof meter.countsBytes !== "boolean" || typeof meter.countsTime !== "boolean") {
    throw new ToolRegistryError(`tool ${key} meter flags must be booleans`);
  }
  if (meter.commitOn !== undefined && meter.commitOn !== "external_dispatch") {
    throw new ToolRegistryError(`tool ${key} has unknown meter commit boundary`);
  }
  if (typeof d.execute !== "function") {
    throw new ToolRegistryError(`tool ${key} must provide an execute function`);
  }
  if (d.model !== undefined) {
    const model = d.model as unknown;
    if (
      typeof model !== "object" ||
      model === null ||
      typeof (model as { formatOutput?: unknown }).formatOutput !== "function"
    ) {
      throw new ToolRegistryError(`tool ${key} model.formatOutput must be a function`);
    }
  }
  if (!isTypeBoxSchema(d.inputSchema)) {
    throw new ToolRegistryError(`tool ${key} inputSchema must be a TypeBox schema`);
  }
  if (!isTypeBoxSchema(d.outputSchema)) {
    throw new ToolRegistryError(`tool ${key} outputSchema must be a TypeBox schema`);
  }
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/**
 * Builds a deep immutable snapshot of a Definition. Schemas are copied with
 * TypeBox's own Clone so the TypeBox `~kind` marker (schema identity) is
 * preserved; identity/retry/meter/model are copied into fresh objects; the
 * executor function reference is captured once so later swaps of the caller's
 * `execute` slot cannot reach the registry.
 */
function buildSnapshot(definition: ToolDefinition<any, any>): ToolDefinition<any, any> {
  const base: ToolDefinition<any, any> = {
    identity: { name: definition.identity.name, version: definition.identity.version },
    label: definition.label,
    description: definition.description,
    ...(definition.userFacing === undefined ? {} : { userFacing: { name: definition.userFacing.name, description: definition.userFacing.description } }),
    inputSchema: Clone(definition.inputSchema),
    outputSchema: Clone(definition.outputSchema),
    effect: definition.effect,
    timeoutMs: definition.timeoutMs,
    retry: { maxRetries: definition.retry.maxRetries, backoffMs: definition.retry.backoffMs },
    concurrency: definition.concurrency,
    meter: {
      category: definition.meter.category,
      countsBytes: definition.meter.countsBytes,
      countsTime: definition.meter.countsTime,
      ...(definition.meter.commitOn === undefined ? {} : { commitOn: definition.meter.commitOn }),
    },
    execute: definition.execute,
  };
  const snapshot =
    definition.model !== undefined
      ? { ...base, model: { formatOutput: definition.model.formatOutput } }
      : base;
  return deepFreeze(snapshot);
}

function toManifestEntry(definition: ToolDefinition<any, any>): ToolManifestEntry {
  return {
    identity: { name: definition.identity.name, version: definition.identity.version },
    label: definition.label,
    description: definition.description,
    effect: definition.effect,
    timeoutMs: definition.timeoutMs,
    retry: { maxRetries: definition.retry.maxRetries, backoffMs: definition.retry.backoffMs },
    concurrency: definition.concurrency,
    meter: {
      category: definition.meter.category,
      countsBytes: definition.meter.countsBytes,
      countsTime: definition.meter.countsTime,
    },
  };
}

function compareManifestEntries(a: ToolManifestEntry, b: ToolManifestEntry): number {
  if (a.identity.name < b.identity.name) return -1;
  if (a.identity.name > b.identity.name) return 1;
  return a.identity.version - b.identity.version;
}

export class ToolRegistry {
  #definitions = new Map<string, ToolDefinition<any, any>>();
  #frozen = false;

  register<TInput extends TSchema, TOutput extends TSchema>(
    definition: ToolDefinition<TInput, TOutput>,
  ): this {
    if (this.#frozen) {
      throw new ToolRegistryError("registry is frozen; no new tools can be registered");
    }
    assertValidDefinition(definition);
    const key = identityKey(definition.identity);
    if (this.#definitions.has(key)) {
      throw new ToolRegistryError(`tool already registered: ${key}`);
    }
    this.#definitions.set(key, buildSnapshot(definition));
    return this;
  }

  freeze(): void {
    this.#frozen = true;
  }

  resolve(identity: ToolIdentityLike): ToolDefinition<any, any> {
    const definition = this.#definitions.get(identityKey(identity));
    if (!definition) {
      throw new ToolRegistryError(`tool not found: ${identityKey(identity)}`);
    }
    return definition;
  }

  /** Enumerates registered definitions as frozen snapshots in a frozen array. */
  list(): readonly ToolDefinition<any, any>[] {
    return Object.freeze([...this.#definitions.values()]);
  }

  manifest(): readonly ToolManifestEntry[] {
    const entries: ToolManifestEntry[] = [];
    for (const definition of this.#definitions.values()) {
      entries.push(toManifestEntry(definition));
    }
    entries.sort(compareManifestEntries);
    return entries;
  }
}
