import { describe, expect, it } from "vitest";
import { Type } from "typebox";
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
    inputSchema,
    outputSchema,
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
  it("resolves the exact registered definition", () => {
    const registry = new ToolRegistry();
    registry.register(echoV1);
    expect(registry.resolve({ name: "echo", version: 1 })).toBe(echoV1);
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
