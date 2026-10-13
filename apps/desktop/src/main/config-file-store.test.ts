import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLegacyConfigFileStore, createScopedConfigFileStore } from "./config-file-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), "config-files-test-")); roots.push(dir); return dir; }

describe("configuration file ports", () => {
  it("retains the legacy JSON document and writes private replacement files", () => {
    const dir = root(); const file = join(dir, "nested", "settings.json");
    const store = createLegacyConfigFileStore(file);
    expect(store.read()).toBeUndefined(); expect(readdirSync(dir)).toEqual([]);
    const document = { version: 1, llm: { activeProfileId: null, profiles: [] } };
    store.write(document); expect(store.read()).toEqual(document);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    store.write({ version: 1, changed: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, changed: true });
    expect(readdirSync(join(dir, "nested"))).toEqual(["settings.json"]);
    writeFileSync(file, "{"); expect(() => store.read()).toThrow();
  });
  it("reads lazily, separates same keys across scopes and contains path inputs", () => {
    const dir = root(); const store = createScopedConfigFileStore(join(dir, "private"));
    expect(store.read({ scope: "first", key: "shared" })).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
    store.write({ scope: "first", key: "shared" }, { value: "one" });
    store.write({ scope: "second", key: "shared" }, { value: "two" });
    expect(store.read({ scope: "first", key: "shared" })).toEqual({ value: "one" });
    expect(store.read({ scope: "second", key: "shared" })).toEqual({ value: "two" });
    for (const value of ["../escape", "/tmp/escape", "..", "x\\escape", "", "x\0escape"]) {
      expect(() => store.write({ scope: "first", key: value }, {})).toThrow();
      expect(() => store.read({ scope: value, key: "shared" })).toThrow();
    }
    const files = readdirSync(join(dir, "private"), { recursive: true }).filter(file => String(file).endsWith(".json"));
    expect(files).toHaveLength(2);
    const firstFile = join(dir, "private", String(files[0]));
    expect(statSync(firstFile).mode & 0o777).toBe(0o600);
    writeFileSync(firstFile, "{");
    const read = (scope: string) => { try { return store.read({ scope, key: "shared" }); } catch { return "corrupt"; } };
    expect([read("first"), read("second")].filter(value => value === "corrupt")).toHaveLength(1);
  });
  it("propagates failed replacements and cleans only its temporary file", () => {
    const dir = root(); const target = join(dir, "blocked.json"); mkdirSync(target);
    const store = createLegacyConfigFileStore(target);
    expect(() => store.write({ value: "test" })).toThrow();
    expect(statSync(target).isDirectory()).toBe(true);
    expect(readdirSync(dir)).toEqual(["blocked.json"]);
  });
});
