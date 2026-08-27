import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ToolRegistry, ToolRegistryError } from "./registry.js";
import type { ToolDefinition } from "./definition.js";

const inputSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
const outputSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });

function definition(
  name: string,
  version: number,
): ToolDefinition<typeof inputSchema, typeof outputSchema> {
  return {
    identity: { name, version },
    label: name,
    description: "Test tool",
    inputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ text: Type.String() }, { additionalProperties: false }),
    effect: "network.read.public",
    timeoutMs: 10_000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 1,
    meter: { category: "none", countsBytes: false, countsTime: true },
    execute: async ({ text }) => ({ text }),
  };
}

const echoV1 = definition("echo", 1);
const echoV2 = definition("echo", 2);
const zebraV1 = definition("zebra", 1);

describe("ToolRegistry", () => {
  it("resolves an equivalent immutable snapshot of the exact registered definition", () => {
    const registry = new ToolRegistry();
    registry.register(echoV1);
    const resolved = registry.resolve({ name: "echo", version: 1 });
    expect(resolved.identity).toEqual(echoV1.identity);
    expect(resolved.label).toBe(echoV1.label);
    expect(resolved.inputSchema).toEqual(echoV1.inputSchema);
    expect(resolved.execute).toBe(echoV1.execute);
  });

  it("rejects duplicate registration of the same identity", () => {
    const registry = new ToolRegistry();
    registry.register(echoV1);
    expect(() => registry.register(definition("echo", 1))).toThrow(ToolRegistryError);
  });

  it("rejects unknown tools and unknown versions", () => {
    const registry = new ToolRegistry();
    registry.register(echoV1);
    expect(() => registry.resolve({ name: "echo", version: 2 })).toThrow(ToolRegistryError);
    expect(() => registry.resolve({ name: "missing", version: 1 })).toThrow(ToolRegistryError);
  });

  it("freezes the registry against later registration and returns no mutation handle", () => {
    const registry = new ToolRegistry();
    registry.register(echoV1);
    registry.freeze();
    expect(() => registry.register(echoV2)).toThrow(/frozen/);
    expect(registry.freeze()).toBeUndefined();
  });

  it("emits manifest entries in name then version ascending order without executors", () => {
    const registry = new ToolRegistry();
    registry.register(zebraV1);
    registry.register(echoV2);
    registry.register(echoV1);
    const manifest = registry.manifest();
    expect(manifest.map((entry) => `${entry.identity.name}@${entry.identity.version}`)).toEqual([
      "echo@1",
      "echo@2",
      "zebra@1",
    ]);
    expect(JSON.stringify(manifest)).not.toContain("execute");
  });

  it("rejects invalid definitions instead of normalizing them", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(definition(" ", 1))).toThrow(ToolRegistryError);
    expect(() => registry.register(definition("echo", 0))).toThrow(ToolRegistryError);
    const invalidRetry = {
      ...echoV1,
      retry: { maxRetries: 3, backoffMs: 0 },
    } as unknown as ToolDefinition<typeof inputSchema, typeof outputSchema>;
    expect(() => registry.register(invalidRetry)).toThrow(ToolRegistryError);
  });

  it("returns immutable manifest copies of definition fields", () => {
    const registry = new ToolRegistry();
    registry.register(echoV1);
    const [entry] = registry.manifest();
    expect(entry).toBeDefined();
    expect(entry!.identity).toEqual({ name: "echo", version: 1 });
    expect(entry!.identity).not.toBe(echoV1.identity);
  });
});

describe("ToolRegistry immutability (focused revision)", () => {
  it("keeps the registry snapshot stable when the original definition is mutated after register (repro #4)", async () => {
    const def = definition("echo", 1);
    const registry = new ToolRegistry();
    registry.register(def);
    (def as any).identity.name = "mutated";
    (def as any).identity = { name: "replaced", version: 9 };
    (def as any).effect = "document.write";
    (def as any).retry.maxRetries = 2;
    (def as any).meter.category = "search";
    (def as any).model = { formatOutput: () => "other" };
    (def as any).execute = async () => ({ text: "other" });
    const resolved = registry.resolve({ name: "echo", version: 1 });
    expect(resolved.identity).toEqual({ name: "echo", version: 1 });
    expect(resolved.effect).toBe("network.read.public");
    expect(resolved.retry.maxRetries).toBe(0);
    expect(resolved.meter.category).toBe("none");
    expect(() => registry.resolve({ name: "mutated", version: 1 })).toThrow(ToolRegistryError);
    expect(() => registry.resolve({ name: "replaced", version: 9 })).toThrow(ToolRegistryError);
    expect(JSON.stringify(registry.manifest())).not.toContain("mutated");
    expect(JSON.stringify(registry.manifest())).not.toContain("replaced");
    expect(
      await resolved.execute(
        { text: "x" },
        { traceId: "t", actor: "developer_probe" },
        new AbortController().signal,
      ),
    ).toEqual({ text: "x" });
  });

  it("keeps the registry snapshot stable even before freeze", () => {
    const def = definition("echo", 1);
    const registry = new ToolRegistry();
    registry.register(def);
    (def as any).identity.name = "mutated";
    (def as any).inputSchema.properties.text.minLength = 99;
    (def as any).outputSchema = Type.Object({ other: Type.String() }, { additionalProperties: false });
    const resolved = registry.resolve({ name: "echo", version: 1 });
    expect(resolved.identity.name).toBe("echo");
    expect(resolved.inputSchema).not.toBe(def.inputSchema);
    expect((resolved.inputSchema as any).properties.text.minLength).not.toBe(99);
    expect(Value.Check(resolved.inputSchema, { text: "x" })).toBe(true);
  });

  it("resolve returns deeply frozen snapshots that cannot be mutated", () => {
    const registry = new ToolRegistry();
    registry.register(echoV1);
    const resolved = registry.resolve({ name: "echo", version: 1 });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.identity)).toBe(true);
    expect(Object.isFrozen(resolved.retry)).toBe(true);
    expect(Object.isFrozen(resolved.meter)).toBe(true);
    expect(() => {
      (resolved as any).identity.name = "hacked";
    }).toThrow(TypeError);
    expect(() => {
      (resolved as any).effect = "document.write";
    }).toThrow(TypeError);
    expect(registry.resolve({ name: "echo", version: 1 }).identity.name).toBe("echo");
  });

  it("mutating returned manifest entries or arrays cannot change subsequent manifests", () => {
    const registry = new ToolRegistry();
    registry.register(echoV1);
    registry.register(echoV2);
    const manifest = registry.manifest();
    manifest[0]!.identity.name = "hacked";
    manifest[0]!.retry.maxRetries = 2;
    const next = registry.manifest();
    expect(next).not.toBe(manifest);
    expect(next[0]!.identity.name).toBe("echo");
    expect(next[0]!.retry.maxRetries).toBe(0);
  });

  it("rejects fake and JSON-cloned schemas that are not real TypeBox schemas", () => {
    const registry = new ToolRegistry();
    const fakeDef = {
      ...echoV1,
      inputSchema: { type: "object", properties: {} },
    } as unknown as ToolDefinition<typeof inputSchema, typeof outputSchema>;
    expect(() => registry.register(fakeDef)).toThrow(ToolRegistryError);
    const jsonClonedSchema = JSON.parse(JSON.stringify(inputSchema));
    const clonedDef = {
      ...echoV1,
      outputSchema: jsonClonedSchema,
    } as unknown as ToolDefinition<typeof inputSchema, typeof outputSchema>;
    expect(() => registry.register(clonedDef)).toThrow(ToolRegistryError);
  });

  it("preserves real TypeBox schemas through the registry snapshot", () => {
    const registry = new ToolRegistry();
    registry.register(echoV1);
    const resolved = registry.resolve({ name: "echo", version: 1 });
    expect(Value.Check(resolved.inputSchema, { text: "x" })).toBe(true);
    expect(Value.Check(resolved.outputSchema, { text: "x" })).toBe(true);
    expect(Value.Check(resolved.inputSchema, { text: 42 })).toBe(false);
  });

  it("rejects non-integer retry backoff to match ToolManifestEntrySchema", () => {
    const registry = new ToolRegistry();
    const bad = {
      ...echoV1,
      retry: { maxRetries: 1, backoffMs: 1.5 },
    } as unknown as ToolDefinition<typeof inputSchema, typeof outputSchema>;
    expect(() => registry.register(bad)).toThrow(ToolRegistryError);
  });

  it("throws ToolRegistryError for malformed definitions instead of leaking TypeError", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        ...echoV1,
        identity: undefined,
      } as unknown as ToolDefinition<typeof inputSchema, typeof outputSchema>),
    ).toThrow(ToolRegistryError);
    expect(() =>
      registry.register({} as unknown as ToolDefinition<typeof inputSchema, typeof outputSchema>),
    ).toThrow(ToolRegistryError);
    expect(() =>
      registry.register(undefined as unknown as ToolDefinition<typeof inputSchema, typeof outputSchema>),
    ).toThrow(ToolRegistryError);
    expect(() =>
      registry.register({
        ...echoV1,
        retry: undefined,
      } as unknown as ToolDefinition<typeof inputSchema, typeof outputSchema>),
    ).toThrow(ToolRegistryError);
  });

  it("list returns a frozen array that cannot mutate the registry view", () => {
    const registry = new ToolRegistry();
    registry.register(echoV1);
    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(Object.isFrozen(listed)).toBe(true);
    expect(() => {
      (listed as unknown[]).push({} as never);
    }).toThrow(TypeError);
    expect(registry.list()).toHaveLength(1);
    registry.freeze();
    expect(registry.list()).toHaveLength(1);
  });
});
