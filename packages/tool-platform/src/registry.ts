import type { TSchema } from "typebox";
import type { ToolManifestEntry } from "@deepfield/contracts";
import type { ToolDefinition } from "./definition.js";

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
  "project.read",
  "imported_file.read",
  "external.open",
  "document.write",
] as const);

const METER_CATEGORIES = new Set(["search", "fetch", "link_check", "parse", "none"] as const);

function identityKey(identity: ToolIdentityLike): string {
  return `${identity.name}@${identity.version}`;
}

function assertValidDefinition(definition: ToolDefinition<any, any>): void {
  const { identity, label, description, effect, timeoutMs, retry, concurrency, meter } = definition;
  const key = identityKey(identity);
  if (typeof identity?.name !== "string" || identity.name.trim().length === 0) {
    throw new ToolRegistryError("tool definition name must be a non-empty string");
  }
  if (!Number.isInteger(identity.version) || identity.version < 1) {
    throw new ToolRegistryError(`tool ${key} version must be a positive integer`);
  }
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new ToolRegistryError(`tool ${key} label must be a non-empty string`);
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new ToolRegistryError(`tool ${key} description must be a non-empty string`);
  }
  if (!TOOL_EFFECTS.has(effect)) {
    throw new ToolRegistryError(`tool ${key} has unknown effect`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new ToolRegistryError(`tool ${key} timeoutMs must be a positive integer`);
  }
  if (typeof retry?.maxRetries !== "number" || ![0, 1, 2].includes(retry.maxRetries)) {
    throw new ToolRegistryError(`tool ${key} retry.maxRetries must be 0, 1 or 2`);
  }
  if (
    typeof retry.backoffMs !== "number" ||
    !Number.isFinite(retry.backoffMs) ||
    retry.backoffMs < 0
  ) {
    throw new ToolRegistryError(`tool ${key} retry.backoffMs must be a non-negative number`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ToolRegistryError(`tool ${key} concurrency must be a positive integer`);
  }
  if (typeof meter?.category !== "string" || !METER_CATEGORIES.has(meter.category)) {
    throw new ToolRegistryError(`tool ${key} has unknown meter category`);
  }
  if (typeof meter.countsBytes !== "boolean" || typeof meter.countsTime !== "boolean") {
    throw new ToolRegistryError(`tool ${key} meter flags must be booleans`);
  }
  if (typeof definition.execute !== "function") {
    throw new ToolRegistryError(`tool ${key} must provide an execute function`);
  }
  if (definition.inputSchema == null || typeof definition.inputSchema !== "object") {
    throw new ToolRegistryError(`tool ${key} inputSchema must be a TypeBox schema`);
  }
  if (definition.outputSchema == null || typeof definition.outputSchema !== "object") {
    throw new ToolRegistryError(`tool ${key} outputSchema must be a TypeBox schema`);
  }
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
    this.#definitions.set(key, definition);
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

  manifest(): readonly ToolManifestEntry[] {
    const entries: ToolManifestEntry[] = [];
    for (const definition of this.#definitions.values()) {
      entries.push(toManifestEntry(definition));
    }
    entries.sort(compareManifestEntries);
    return entries;
  }
}
