import { describe, expect, it } from "vitest";
import { validateManifest } from "./manifest.js";

const validManifest = {
  id: "probe",
  name: "Probe",
  description: "Capability package boundary probe",
  version: "1.0.0",
  protocolVersion: 1,
  hostApiVersion: 1,
  entries: {
    main: "dist/main.js",
    worker: "dist/worker.js",
    ui: "dist/ui.js",
  },
  navigation: { title: "Probe", order: 10, route: "/probe" },
  requirements: ["agent.run"],
  actions: [{
    id: "probe.run",
    description: "Run the probe",
    mode: "immediate",
    inputSchema: {
      type: "object",
      properties: { label: { type: "string", minLength: 1 } },
      required: ["label"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { ok: { enum: [true] } },
      required: ["ok"],
      additionalProperties: false,
    },
    documentation: { path: "docs/probe.md", version: "1" },
    permissions: ["probe.execute"],
    requiresConfirmation: false,
  }],
} as const;

const digest = `sha256:${"a".repeat(64)}`;
const validV2Manifest = {
  id: "records",
  name: "Records",
  description: "Look up domain-neutral records",
  version: "2.0.0",
  protocolVersion: 2,
  hostApiVersion: 2,
  entries: { main: "dist/main.js" },
  requirements: [],
  actions: [{
    id: "records.find",
    title: "Find records",
    description: "Find matching records",
    mode: "immediate",
    effects: { data: "read", consumesResources: true },
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
      additionalProperties: false,
    },
    documentation: { path: "docs/find.md", version: "1", digest },
    permissions: ["records.read"],
    requiresConfirmation: false,
    contractDigest: digest,
  }],
} as const;

function deeplyNestedArraySchema(depth: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < depth; index += 1) schema = { type: "array", items: schema };
  return schema;
}

function deeplyNestedArrayValue(depth: number): unknown[] {
  let value: unknown[] = [];
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

describe("validateManifest", () => {
  it("accepts the closed v1 probe declaration", () => {
    expect(validateManifest(validManifest)).toEqual({ ok: true, manifest: validManifest });
  });

  it("accepts a v2 main-only action while keeping worker and UI optional", () => {
    expect(validateManifest(validV2Manifest)).toEqual({ ok: true, manifest: validV2Manifest });
  });

  it("accepts optional package-relative user help and preserves old manifests", () => {
    expect(validateManifest(validV2Manifest).ok).toBe(true);
    const manifest = { ...validV2Manifest, help: "docs/help.md" };
    expect(validateManifest(manifest)).toEqual({ ok: true, manifest });
    for (const help of ["../outside.md", "/outside.md", "https://example.test/help.md", ""]) {
      expect(validateManifest({ ...manifest, help })).toEqual({ ok: false, code: "invalid_manifest" });
    }
  });

  it("accepts standard nested pattern and anyOf schema constraints", () => {
    const action = validV2Manifest.actions[0];
    const inputSchema = { type: "object", properties: {
      website: { anyOf: [{ type: "string", pattern: "^https://" }, { type: "null" }] },
      direction: { anyOf: [{ type: "string", const: "market" }, { type: "string", const: "technology" }] },
    }, required: ["website"], additionalProperties: false };
    const manifest = { ...validV2Manifest, actions: [{ ...action, inputSchema }] };
    expect(validateManifest(manifest)).toEqual({ ok: true, manifest });
  });

  it("keeps the v1 worker entry mandatory", () => {
    const { worker: _worker, ...entries } = validManifest.entries;
    expect(validateManifest({ ...validManifest, entries })).toEqual({ ok: false, code: "invalid_manifest" });
  });

  it.each(["1.0", "v1.0.0", "01.0.0", "1.0.0-01"])("rejects a non-SemVer package version: %s", (version) => {
    expect(validateManifest({ ...validManifest, version })).toEqual({ ok: false, code: "invalid_manifest" });
  });

  it.each([
    { ...validManifest, protocolVersion: 2 },
    { ...validManifest, hostApiVersion: 2 },
  ])("reports unsupported protocol and host API majors as incompatible", (manifest) => {
    expect(validateManifest(manifest)).toEqual({ ok: false, code: "incompatible" });
  });

  it("rejects duplicate action ids", () => {
    const duplicate = { ...validManifest, actions: [validManifest.actions[0], validManifest.actions[0]] };
    expect(validateManifest(duplicate)).toEqual({ ok: false, code: "invalid_manifest" });
  });

  it.each([
    { ...validManifest, entries: { ...validManifest.entries, main: "/tmp/main.js" } },
    { ...validManifest, entries: { ...validManifest.entries, worker: "dist/../worker.js" } },
    { ...validManifest, actions: [{ ...validManifest.actions[0], documentation: { path: "../probe.md", version: "1" } }] },
    { ...validManifest, entries: { ...validManifest.entries, main: "https://example.com/main.js" } },
    { ...validManifest, entries: { ...validManifest.entries, worker: "C:dist/worker.js" } },
    { ...validManifest, actions: [{ ...validManifest.actions[0], documentation: { path: "file:docs/probe.md", version: "1" } }] },
  ])("rejects absolute and parent-traversing package paths", (manifest) => {
    expect(validateManifest(manifest)).toEqual({ ok: false, code: "invalid_manifest" });
  });

  it("rejects remote references and unsupported schema keywords at every schema depth", () => {
    const withRemoteRef = {
      ...validManifest,
      actions: [{
        ...validManifest.actions[0],
        inputSchema: {
          type: "object",
          properties: { label: { $ref: "https://example.com/schema.json" } },
        },
      }],
    };
    expect(validateManifest(withRemoteRef)).toEqual({ ok: false, code: "invalid_manifest" });
  });

  it("returns invalid_manifest when recursive schema validation exceeds the checker stack", () => {
    const deeplyNested = {
      ...validManifest,
      actions: [{ ...validManifest.actions[0], inputSchema: deeplyNestedArraySchema(3_000) }],
    };

    expect(validateManifest(deeplyNested)).toEqual({ ok: false, code: "invalid_manifest" });
  });

  it("rejects deeply nested enum data before publishing a manifest snapshot", () => {
    const deeplyNested = {
      ...validManifest,
      actions: [{
        ...validManifest.actions[0],
        inputSchema: { enum: [deeplyNestedArrayValue(10_000)] },
      }],
    };

    expect(validateManifest(deeplyNested)).toEqual({ ok: false, code: "invalid_manifest" });
  });

  it.each([
    { ...validManifest, extra: true },
    { ...validManifest, entries: { ...validManifest.entries, extra: "dist/extra.js" } },
    { ...validManifest, actions: [{ ...validManifest.actions[0], extra: true }] },
    { ...validManifest, actions: [{ ...validManifest.actions[0], inputSchema: { type: "string", xUnrecognized: "secret" } }] },
  ])("rejects unknown manifest and schema fields", (manifest) => {
    expect(validateManifest(manifest)).toEqual({ ok: false, code: "invalid_manifest" });
  });
});
