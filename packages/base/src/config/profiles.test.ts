import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { defineConfig } from "./index.js";
import { createConfigRuntime, type ConfigRuntimeOptions } from "./runtime.js";

const schema = Type.Object({ endpoint: Type.String(), nested: Type.Object({ list: Type.Array(Type.Number()), label: Type.Optional(Type.String()) }) }, { additionalProperties: false });
const defaults = { endpoint: "", nested: { list: [1], label: "default" } };
const definition = (key = "accounts", schemaVersion = 1) => defineConfig({ key, schemaVersion, schema, defaults,
  secrets: { token: { requiredForExecution: true } } });
function fixture() {
  const documents = new Map<string, unknown>(), secrets = new Map<string, string>();
  let writes = 0, ids = 0;
  const options: ConfigRuntimeOptions = {
    documents: { read: (a) => structuredClone(documents.get(JSON.stringify(a))), write: (a, d) => { writes++; documents.set(JSON.stringify(a), structuredClone(d)); } },
    secrets: { has: (r) => secrets.has(r), get: (r) => secrets.get(r), set: (r, v) => { secrets.set(r, v); }, delete: (r) => { secrets.delete(r); } },
    newId: () => `id-${++ids}`,
  };
  const runtime = createConfigRuntime(options), scope = runtime.createScope("pkg");
  return { runtime, scope, options, documents, secrets, writes: () => writes };
}

describe("profile collections", () => {
  it("starts empty and distinguishes create/update, save/select and active deletion", async () => {
    const f = fixture(), profiles = f.scope.service.bindProfiles(definition());
    expect(await profiles.getView()).toEqual({ activeProfileId: null, profiles: [] });
    expect(f.writes()).toBe(0);
    await expect(profiles.resolveActive()).rejects.toMatchObject({ reason: "no_active_profile" });
    const saved = await profiles.save({ name: "first", values: defaults });
    const id = saved.profiles[0]!.id;
    expect(saved.activeProfileId).toBeNull();
    await expect(profiles.save({ id: "missing", name: "x", values: defaults })).rejects.toMatchObject({ reason: "profile_not_found" });
    await expect(profiles.activate("missing")).rejects.toMatchObject({ reason: "profile_not_found" });
    await profiles.activate(id);
    await expect(profiles.resolveActive()).rejects.toMatchObject({ reason: "missing_secret" });
    await expect(profiles.delete(id)).rejects.toMatchObject({ reason: "active_profile" });
    await profiles.save({ id, name: "renamed", values: defaults, secrets: { token: "one" } });
    expect((await profiles.resolveActive()).profile).toEqual({ id, name: "renamed" });
    await profiles.activate(null);
    expect((await profiles.delete(id)).profiles).toEqual([]);
    expect(f.secrets.size).toBe(0);
  });

  it("isolates credentials across instances, collections and scopes and deletes only owned refs", async () => {
    const f = fixture(), a = f.scope.service.bindProfiles(definition()), b = f.scope.service.bindProfiles(definition("other"));
    const c = f.runtime.createScope("another").service.bindProfiles(definition());
    const id1 = (await a.save({ name: "one", values: defaults, secrets: { token: "one" } })).profiles[0]!.id;
    const id2 = (await a.save({ name: "two", values: defaults, secrets: { token: "two" } })).profiles[1]!.id;
    const bid = (await b.save({ name: "other", values: defaults, secrets: { token: "other" } })).profiles[0]!.id;
    const cid = (await c.save({ name: "another", values: defaults, secrets: { token: "another" } })).profiles[0]!.id;
    await a.activate(id2); await b.activate(bid); await c.activate(cid);
    await a.delete(id1);
    expect((await a.resolveActive()).secrets.token).toBe("two");
    expect((await b.resolveActive()).secrets.token).toBe("other");
    expect((await c.resolveActive()).secrets.token).toBe("another");
    expect([...f.secrets.values()].sort()).toEqual(["another", "other", "two"]);
    const reopened = createConfigRuntime(f.options).createScope("pkg").service.bindProfiles(definition());
    expect(await reopened.getView()).toEqual(await a.getView());
  });

  it("shares default/revision/clone behavior and uses only draft fields plus same-instance omitted credentials", async () => {
    const f = fixture(), p = f.scope.service.bindProfiles(definition());
    const input = structuredClone(defaults);
    const id = (await p.save({ name: "one", values: input, secrets: { token: "saved" } })).profiles[0]!.id;
    await p.activate(id);
    const original = await p.resolveActive(), writes = f.writes();
    input.nested.list.push(9);
    (await p.getView()).profiles[0]!.values.nested.list.push(8);
    (await p.resolveActive()).values.nested.list.push(7);
    await p.save({ id, name: "one", values: structuredClone(defaults) });
    expect(await p.resolveActive()).toEqual(original);
    expect(f.writes()).toBe(writes);
    const draft = await p.resolveDraft({ id, name: "draft", values: { endpoint: "draft", nested: { list: [2] } } });
    expect(draft.values).toEqual({ endpoint: "draft", nested: { list: [2] } });
    expect(draft.profile.name).toBe("draft");
    expect(draft.secrets.token).toBe("saved");
    expect(draft.identity.draftSessionId).toBeTruthy();
    expect(draft.identity.revision).not.toBe(original.identity.revision);
    expect(f.writes()).toBe(writes);
    await expect(p.resolveDraft({ id: "unknown", name: "draft", values: defaults })).rejects.toMatchObject({ reason: "missing_secret" });
    expect((await p.resolveDraft({ id: "unknown", name: "draft", values: defaults, secrets: { token: "explicit" } })).secrets.token).toBe("explicit");
    await p.save({ id, name: "renamed", values: defaults });
    expect((await p.resolveActive()).identity.revision).not.toBe(original.identity.revision);
    expect(JSON.stringify(await p.getView())).not.toMatch(/saved|revision|credentialRef/);
    expect(JSON.stringify([...f.documents.values()])).not.toContain('"saved"');
  });

  it("rejects mixed bindings and conflicting definitions and revokes all operations on disposal", async () => {
    const f = fixture(), p = f.scope.service.bindProfiles(definition());
    expect(f.scope.service.bindProfiles(definition())).toBe(p);
    expect(() => f.scope.service.bind(definition())).toThrowError(expect.objectContaining({ reason: "definition_conflict" }));
    expect(() => f.scope.service.bindProfiles(definition("accounts", 2))).toThrowError(expect.objectContaining({ reason: "definition_conflict" }));
    f.scope.service.bind(definition("single"));
    expect(() => f.scope.service.bindProfiles(definition("single"))).toThrowError(expect.objectContaining({ reason: "definition_conflict" }));
    f.scope.dispose();
    for (const call of [() => p.getView(), () => p.save({ name: "x", values: defaults }), () => p.activate(null), () => p.delete("x"), () => p.resolveActive(), () => p.resolveDraft({ name: "x", values: defaults })]) {
      await expect(call()).rejects.toMatchObject({ reason: "disposed" });
    }
  });

  it("migrates a collection once, never writes draft migrations, and preserves corrupt or future documents", async () => {
    const f = fixture(), p = f.scope.service.bindProfiles(definition());
    const id = (await p.save({ name: "one", values: defaults, secrets: { token: "saved" } })).profiles[0]!.id;
    await p.activate(id);
    const upgrade = defineConfig({ ...definition("accounts", 2), migrations: { 1: (values) => ({ ...values, endpoint: "upgraded" }) } });
    const upgraded = f.runtime.createScope("pkg").service.bindProfiles(upgrade);
    const before = f.writes();
    await upgraded.resolveDraft({ id, name: "draft", values: defaults });
    expect(f.writes()).toBe(before);
    expect((await upgraded.getView()).profiles[0]!.values.endpoint).toBe("upgraded");
    expect(f.writes()).toBe(before + 1);
    await upgraded.getView(); expect(f.writes()).toBe(before + 1);
    await expect(p.getView()).rejects.toMatchObject({ reason: "unsupported_version" });
    const key = JSON.stringify({ scope: "pkg", key: "accounts" });
    const doc = f.documents.get(key) as Record<string, unknown>;
    doc.activeProfileId = "missing";
    await expect(upgraded.getView()).rejects.toMatchObject({ reason: "invalid_document" });
    expect(f.writes()).toBe(before + 1);
  });

  it("rejects invalid saves without writes and fills only top-level defaults", async () => {
    const f = fixture(), p = f.scope.service.bindProfiles(definition());
    await expect(p.save({ name: "one", values: defaults, secrets: { token: "" } })).rejects.toMatchObject({ reason: "invalid_secrets" });
    await expect(p.save({ name: "", values: defaults })).rejects.toMatchObject({ reason: "invalid_values" });
    await expect(p.save({ name: "one", values: { ...defaults, nested: { list: [NaN] } } })).rejects.toMatchObject({ reason: "invalid_values" });
    expect(f.writes()).toBe(0); expect(f.secrets.size).toBe(0);
    const view = await p.save({ name: "one", values: { nested: { list: [2] } } as typeof defaults });
    expect(view.profiles[0]!.values).toEqual({ endpoint: "", nested: { list: [2] } });
  });

  it("rejects borrowed credential references and incomplete migrations without overwriting data", async () => {
    const f = fixture(), p = f.scope.service.bindProfiles(definition());
    await p.save({ name: "one", values: defaults, secrets: { token: "one" } });
    await p.save({ name: "two", values: defaults, secrets: { token: "two" } });
    const old = structuredClone([...f.documents.values()][0]);
    const missing = f.runtime.createScope("pkg").service.bindProfiles(definition("accounts", 2));
    const broken = f.runtime.createScope("pkg").service.bindProfiles(defineConfig({ ...definition("accounts", 2), migrations: { 1: () => ({ endpoint: 1 }) } }));
    await expect(missing.getView()).rejects.toMatchObject({ reason: "missing_migration" });
    await expect(broken.getView()).rejects.toMatchObject({ reason: "migration_failed" });
    expect([...f.documents.values()][0]).toEqual(old);
    const doc = [...f.documents.values()][0] as { profiles: { credentialRefs: Record<string, string> }[] };
    doc.profiles[1]!.credentialRefs.token = doc.profiles[0]!.credentialRefs.token!;
    await expect(p.getView()).rejects.toMatchObject({ reason: "invalid_document" });
    expect(f.writes()).toBe(2);
  });

  it("propagates document failures after secret writes with safe error context", async () => {
    const f = fixture(), p = f.scope.service.bindProfiles(definition());
    const failure = new Error("port-only detail");
    f.options.documents.write = () => { throw failure; };
    const result = p.save({ name: "one", values: defaults, secrets: { token: "private-test-token" } });
    await expect(result).rejects.toMatchObject({ reason: "storage_failed", cause: failure, context: { scope: "pkg", key: "accounts", operation: "write_document" } });
    expect(f.secrets.size).toBe(1);
    expect(await p.getView()).toEqual({ activeProfileId: null, profiles: [] });
  });
});
