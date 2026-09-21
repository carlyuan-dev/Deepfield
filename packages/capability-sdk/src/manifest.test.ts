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

describe("validateManifest", () => {
  it("accepts the closed v1 probe declaration", () => {
    expect(validateManifest(validManifest)).toEqual({ ok: true, manifest: validManifest });
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

  it.each([
    { ...validManifest, extra: true },
    { ...validManifest, entries: { ...validManifest.entries, extra: "dist/extra.js" } },
    { ...validManifest, actions: [{ ...validManifest.actions[0], extra: true }] },
    { ...validManifest, actions: [{ ...validManifest.actions[0], inputSchema: { type: "string", pattern: "secret" } }] },
  ])("rejects unknown manifest and schema fields", (manifest) => {
    expect(validateManifest(manifest)).toEqual({ ok: false, code: "invalid_manifest" });
  });
});
