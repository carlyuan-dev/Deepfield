import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { defineConfig } from "./index.js";
import { createConfigRuntime, ConfigError, type ConfigAddress, type ConfigRuntimeOptions } from "./runtime.js";

function fixture() {
  const documents = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  let reads = 0, writes = 0, secretWrites = 0, ids = 0;
  let writeError: Error | undefined;
  const options: ConfigRuntimeOptions = {
    documents: {
      read: (address) => { reads++; return structuredClone(documents.get(JSON.stringify(address))); },
      write: (address, document) => {
        if (writeError) throw writeError;
        writes++; documents.set(JSON.stringify(address), structuredClone(document));
      },
    },
    secrets: {
      has: (ref) => secrets.has(ref), get: (ref) => secrets.get(ref),
      set: (ref, value) => { secretWrites++; secrets.set(ref, value); },
      delete: (ref) => { secrets.delete(ref); },
    },
    newId: () => `id-${++ids}`,
  };
  return { options, documents, secrets, runtime: createConfigRuntime(options),
    counts: () => ({ reads, writes, secretWrites }),
    failWrite: (error: Error) => { writeError = error; },
    seed: (address: ConfigAddress, document: unknown) => documents.set(JSON.stringify(address), document),
  };
}
const schema = Type.Object({
  endpoint: Type.String(), timeout: Type.Integer({ minimum: 1 }),
  nested: Type.Object({ label: Type.Optional(Type.String()), list: Type.Array(Type.Number()) }, { additionalProperties: false }),
}, { additionalProperties: false });
const defaults = { endpoint: "", timeout: 30, nested: { label: "default", list: [1, 2] } };
const definition = () => defineConfig({ key: "document-service", schemaVersion: 1, schema, defaults,
  secrets: { apiToken: { requiredForExecution: true }, extra: { requiredForExecution: false } } });

describe("ordinary configuration", () => {
  it("lazily reads independent defaults without writing or inventing credentials", async () => {
    const f = fixture(), scope = f.runtime.createScope("package-a");
    const first = scope.service.bind(definition());
    const second = scope.service.bind(defineConfig({ key: "output", schemaVersion: 1,
      schema: Type.Object({ compact: Type.Boolean() }), defaults: { compact: true } }));
    expect(f.counts()).toEqual({ reads: 0, writes: 0, secretWrites: 0 });
    expect(await first.getView()).toEqual({ values: defaults, secretStatus: { apiToken: false, extra: false } });
    expect(await second.getView()).toEqual({ values: { compact: true }, secretStatus: {} });
    await first.save({ values: defaults });
    await expect(first.resolveSnapshot()).rejects.toMatchObject({ reason: "missing_secret" });
    expect(f.counts().writes).toBe(1);
    expect(f.counts().secretWrites).toBe(0);
    const doc = [...f.documents.values()][0];
    expect(JSON.stringify(doc)).not.toContain("apiToken");
  });

  it("fills only omitted top-level defaults and round trips saved values", async () => {
    const f = fixture(), handle = f.runtime.createScope("package-a").service.bind(definition());
    const view = await handle.save({ values: { nested: { list: [8] } } as typeof defaults });
    expect(view.values).toEqual({ endpoint: "", timeout: 30, nested: { list: [8] } });
    const reopened = createConfigRuntime(f.options).createScope("package-a").service.bind(definition());
    expect(await reopened.getView()).toEqual(view);
  });

  it("preserves omitted secrets, revisions and independent nested ownership", async () => {
    const f = fixture(), handle = f.runtime.createScope("a").service.bind(definition());
    const input = structuredClone(defaults);
    await handle.save({ values: input, secrets: { apiToken: "test-token" } });
    const original = await handle.resolveSnapshot();
    input.nested.list.push(9);
    const view = await handle.getView(); view.values.nested.list.push(10);
    const snapshot = await handle.resolveSnapshot(); snapshot.values.nested.list.push(11);
    await handle.save({ values: structuredClone(defaults) });
    expect(await handle.resolveSnapshot()).toEqual(original);
    expect(f.counts().writes).toBe(1);
    expect(f.counts().secretWrites).toBe(1);
    const draft = await handle.resolveDraft({ values: { ...defaults, endpoint: "draft" } });
    expect(draft.values.endpoint).toBe("draft");
    expect(draft.secrets.apiToken).toBe("test-token");
    expect(draft.identity.draftSessionId).toBeTruthy();
    expect(draft.identity.revision).not.toBe(original.identity.revision);
    expect(f.counts().writes).toBe(1);
    await handle.save({ values: defaults, secrets: { apiToken: "new-token" } });
    expect((await handle.resolveSnapshot()).identity.revision).not.toBe(original.identity.revision);
    expect(original.secrets.apiToken).toBe("test-token");
    expect(JSON.stringify([...f.documents.values()])).not.toMatch(/test-token|new-token/);
    expect(JSON.stringify(await handle.getView())).not.toMatch(/test-token|new-token|revision|credentialRef/);
  });

  it.each([undefined, () => 1, new Date(), 1n, NaN, Infinity, [, 1], Object.assign([1], { extra: 2 })])(
    "rejects non-round-trippable values without writes (%s)", async (invalid) => {
      const f = fixture();
      const handle = f.runtime.createScope("a").service.bind(defineConfig({ key: "json", schemaVersion: 1,
        schema: Type.Object({ value: Type.Unknown() }), defaults: { value: null } }));
      await expect(handle.save({ values: { value: invalid } })).rejects.toBeInstanceOf(ConfigError);
      expect(f.counts().writes).toBe(0);
    });

  it("rejects cycles, type errors and undeclared/empty credentials without mutation", async () => {
    const f = fixture(), handle = f.runtime.createScope("a").service.bind(definition());
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const values of [cycle, { ...defaults, timeout: "30" }, { ...defaults, extra: true }]) {
      await expect(handle.save({ values: values as typeof defaults })).rejects.toBeInstanceOf(ConfigError);
    }
    for (const secrets of [{ apiToken: "" }, { unknown: "test-token" }]) {
      await expect(handle.save({ values: defaults, secrets })).rejects.toBeInstanceOf(ConfigError);
    }
    expect(f.counts().writes).toBe(0); expect(f.counts().secretWrites).toBe(0);
  });

  it("rejects conflicting definitions and isolates scopes and disposed handles", async () => {
    const f = fixture(), scope = f.runtime.createScope("a"), def = definition();
    const handle = scope.service.bind(def);
    expect(scope.service.bind(definition())).toBe(handle);
    for (const changed of [
      { ...def, schemaVersion: 2 }, { ...def, defaults: { ...defaults, timeout: 8 } },
      { ...def, secrets: {} }, { ...def, schema: Type.Object({ endpoint: Type.String() }) },
    ]) expect(() => scope.service.bind(changed)).toThrow(ConfigError);
    await handle.save({ values: defaults, secrets: { apiToken: "a-token" } });
    const other = f.runtime.createScope("b").service.bind(def);
    await expect(other.resolveSnapshot()).rejects.toMatchObject({ reason: "missing_secret" });
    const captured = await handle.resolveSnapshot();
    scope.dispose();
    await expect(handle.getView()).rejects.toMatchObject({ reason: "disposed" });
    expect(() => scope.service.bind(def)).toThrow(ConfigError);
    expect(captured.secrets.apiToken).toBe("a-token");
  });

  it("migrates all steps on copies and writes only the final validated document", async () => {
    const f = fixture(), old = f.runtime.createScope("a").service.bind(definition());
    await old.save({ values: defaults, secrets: { apiToken: "test-token" } });
    const previous = structuredClone([...f.documents.values()][0]);
    const upgraded = defineConfig({ ...definition(), schemaVersion: 3, migrations: {
      1: (value) => { value.endpoint = "migrated"; return value; },
      2: (value) => ({ ...value, timeout: 90 }),
    } });
    const handle = createConfigRuntime(f.options).createScope("a").service.bind(upgraded);
    expect((await handle.resolveSnapshot()).values).toEqual({ ...defaults, endpoint: "migrated", timeout: 90 });
    expect(f.counts().writes).toBe(2);
    expect((previous as { values: unknown }).values).toEqual(defaults);
    expect((await handle.resolveSnapshot()).secrets.apiToken).toBe("test-token");
    expect(f.counts().writes).toBe(2);
  });

  it.each(["missing", "throws", "invalid", "future", "corrupt"])("preserves stored document when %s prevents loading", async (mode) => {
    const f = fixture();
    await f.runtime.createScope("a").service.bind(definition()).save({ values: defaults });
    const document = [...f.documents.values()][0] as Record<string, unknown>;
    if (mode === "future") document.schemaVersion = 9;
    if (mode === "corrupt") document.values = { timeout: "bad" };
    const before = structuredClone(document);
    const def = mode === "corrupt" ? definition() : defineConfig({ ...definition(), schemaVersion: 2,
      migrations: mode === "throws" ? { 1: () => { throw new Error("private raw value"); } } :
        mode === "invalid" ? { 1: () => ({ timeout: "bad" }) } : {},
    });
    const handle = createConfigRuntime(f.options).createScope("a").service.bind(def);
    await expect(handle.getView()).rejects.toBeInstanceOf(ConfigError);
    expect([...f.documents.values()][0]).toEqual(before);
    expect(f.counts().writes).toBe(1);
  });

  it("propagates write failures with safe identity and retained internal cause", async () => {
    const f = fixture(), handle = f.runtime.createScope("a").service.bind(definition());
    const cause = new Error("disk error test-token"); f.failWrite(cause);
    const error = await handle.save({ values: defaults, secrets: { apiToken: "test-token" } }).catch((error: unknown) => error);
    expect(error).toMatchObject({ reason: "storage_failed", cause, context: { scope: "a", key: "document-service" } });
    expect(String(error)).not.toContain("test-token");
    expect(JSON.stringify(error)).not.toContain("test-token");
    expect(f.documents.size).toBe(0);
    expect(f.counts().secretWrites).toBe(1); // Separate ports are deliberately not a transaction.
  });

  it("does not persist migrations during draft diagnostics or invalid saves", async () => {
    const f = fixture();
    await f.runtime.createScope("a").service.bind(definition()).save({ values: defaults, secrets: { apiToken: "test-token" } });
    const before = structuredClone([...f.documents.values()][0]);
    const next = defineConfig({ ...definition(), schemaVersion: 2, migrations: { 1: (values) => ({ ...values, timeout: 99 }) } });
    const handle = createConfigRuntime(f.options).createScope("a").service.bind(next);
    await handle.resolveDraft({ values: defaults });
    await expect(handle.save({ values: { ...defaults, timeout: "bad" } as unknown as typeof defaults })).rejects.toBeInstanceOf(ConfigError);
    expect([...f.documents.values()][0]).toEqual(before);
    expect(f.counts().writes).toBe(1);
  });

  it("treats all credential names as own properties, including prototype names", async () => {
    const f = fixture();
    const def = defineConfig({ key: "named", schemaVersion: 1, schema: Type.Object({ ready: Type.Boolean() }),
      defaults: { ready: true }, secrets: Object.fromEntries(["toString", "__proto__"].map((name) => [name, { requiredForExecution: true }])) });
    const handle = f.runtime.createScope("a").service.bind(def);
    await expect(handle.resolveDraft({ values: { ready: true } })).rejects.toMatchObject({ reason: "missing_secret" });
    await handle.save({ values: { ready: true }, secrets: Object.fromEntries([["toString", "token-one"], ["__proto__", "token-two"]]) });
    const snapshot = await handle.resolveSnapshot();
    expect(Object.entries(snapshot.secrets)).toEqual([["toString", "token-one"], ["__proto__", "token-two"]]);
    expect(await handle.getView()).toEqual({ values: { ready: true }, secretStatus: Object.fromEntries([["toString", true], ["__proto__", true]]) });
  });
});
