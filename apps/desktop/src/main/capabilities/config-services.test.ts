import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createCapabilityHostServices } from "@deepfield/capability-sdk";
import { defineConfig, type ScopedConfigService } from "@deepfield/base/config";
import { createConfigRuntime } from "@deepfield/base/config/runtime";
import { createCapabilityConfigServices } from "./config-services.js";

const definition = defineConfig({ key: "connection", schemaVersion: 1,
  schema: Type.Object({ endpoint: Type.String() }), defaults: { endpoint: "" },
  secrets: { token: { requiredForExecution: true } } });
function fixture() {
  const documents = new Map<string, unknown>(); const secrets = new Map<string, string>(); let id = 0;
  const runtime = createConfigRuntime({ documents: {
    read: address => documents.get(JSON.stringify(address)),
    write: (address, document) => { documents.set(JSON.stringify(address), structuredClone(document)); },
  }, secrets: { has: ref => secrets.has(ref), get: ref => secrets.get(ref),
    set: (ref, value) => { secrets.set(ref, value); }, delete: ref => { secrets.delete(ref); } }, newId: () => `id-${++id}` });
  return { runtime, documents };
}

describe("package scoped configuration services", () => {
  it("exposes only a package service and delegates the existing host services unchanged", async () => {
    const { runtime } = fixture(); const global = { activeProfileId: "global-profile" };
    const base = createCapabilityHostServices({ "model.configuration": global });
    const a = createCapabilityConfigServices(base, runtime.createScope("package-a").service);
    const b = createCapabilityConfigServices(base, runtime.createScope("package-b").service);
    expect(a.version).toBe(1); expect(a.has("config.v1")).toBe(true);
    expect(a.get("model.configuration")).toBe(global); expect(a.has("unknown")).toBe(false);
    expect(() => a.get("unknown")).toThrow("missing_host_service");
    const configA = a.get<ScopedConfigService>("config.v1");
    const configB = b.get<ScopedConfigService>("config.v1");
    expect(configA).not.toHaveProperty("createScope"); expect(configA).not.toHaveProperty("dispose");
    const one = configA.bind({ ...definition, scope: "package-b" } as typeof definition);
    const two = configB.bind(definition);
    await one.save({ values: { endpoint: "one" }, secrets: { token: "fake-a" } });
    await two.save({ values: { endpoint: "two" }, secrets: { token: "fake-b" } });
    expect(await one.resolveSnapshot()).toMatchObject({ values: { endpoint: "one" }, secrets: { token: "fake-a" }, identity: { scope: "package-a" } });
    expect(await two.resolveSnapshot()).toMatchObject({ values: { endpoint: "two" }, secrets: { token: "fake-b" }, identity: { scope: "package-b" } });
    expect(JSON.stringify(await one.getView())).not.toContain("fake-a");
    expect(() => configA.bind({ ...definition, key: "../package-b/connection" })).toThrow();
    const preferences = configA.bind(defineConfig({ key: "preferences", schemaVersion: 1,
      schema: Type.Object({ compact: Type.Boolean() }), defaults: { compact: false } }));
    await preferences.save({ values: { compact: true } });
    expect(await preferences.getView()).toEqual({ values: { compact: true }, secretStatus: {} });
    const privateProfiles = configA.bindProfiles({ ...definition, key: "accounts" });
    const saved = await privateProfiles.save({ name: "Private", values: { endpoint: "private" }, secrets: { token: "fake-private" } });
    await privateProfiles.activate(saved.profiles[0]!.id);
    expect(global.activeProfileId).toBe("global-profile");
    expect((await configB.bindProfiles({ ...definition, key: "accounts" }).getView()).profiles).toEqual([]);
  });
});
