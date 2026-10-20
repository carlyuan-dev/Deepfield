import { afterEach, expect, it } from "vitest";
import { openDatabase, type DatabaseOwner } from "./runtime.js";
import type { ModuleMigration, SqlValue } from "./index.js";
import { build } from "esbuild";

const owners: DatabaseOwner[] = [];
function fixture() { const owner = openDatabase(":memory:"); owners.push(owner); owner.database.exec("CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT)"); return owner; }
afterEach(() => owners.splice(0).forEach((owner) => owner.close()));

it("keeps Database and Usage safe entries browser-bundleable without SQLite runtime", async () => {
  const result = await build({ entryPoints: [new URL("./index.ts", import.meta.url).pathname, new URL("../usage/index.ts", import.meta.url).pathname], outdir: "unused", bundle: true, platform: "browser", write: false, metafile: true });
  expect(Object.keys(result.metafile!.inputs).some((path) => /database\/runtime|usage\/sqlite/.test(path))).toBe(false);
});

it("binds CRUD values and snapshots controlled declarations", () => {
  const { database: db } = fixture();
  const declaration = { name: "records", primaryKey: "id", columns: ["id", "value"] };
  const table = db.table(declaration); declaration.name = "missing"; declaration.columns.length = 0;
  const literal = "'); DROP TABLE records; --";
  expect(table.insert({ id: 1, value: literal }).changes).toBe(1);
  expect(table.findById(1)?.value).toBe(literal);
  table.update({ id: 1 }, { value: null });
  expect(table.delete({ value: null }).changes).toBe(1);
  expect(table.findById(1)).toBeUndefined();
  const large = 9007199254740993n;
  expect(table.insert({ id: large, value: "large" })).toEqual({ changes: 1, lastInsertRowid: large });
});

it("rejects unsafe identifiers, columns, empty conditions/patches and non-SQL bindings", () => {
  const { database: db } = fixture(); const table = db.table({ name: "records", primaryKey: "id", columns: ["id", "value"] });
  expect(() => db.table({ name: "records; DROP TABLE records", primaryKey: "id", columns: ["id"] })).toThrow("identifier");
  expect(() => table.insert({ surprise: 1 })).toThrow("column");
  expect(() => table.delete({})).toThrow("empty");
  expect(() => table.update({ id: 1 }, {})).toThrow("empty");
  for (const invalid of [undefined, true, {}, NaN]) expect(() => db.run("INSERT INTO records(value) VALUES (?)", invalid as SqlValue)).toThrow("binding");
});

it("commits and rolls back the same connection and rejects nested scopes", () => {
  const owner = fixture(); const db = owner.database; const other = owner.scope("other").database;
  expect(db.transaction(() => { other.run("INSERT INTO records VALUES (1, 'ok')"); return 7; })).toBe(7);
  const failure = new Error("original");
  expect(() => db.transaction(() => { db.run("INSERT INTO records VALUES (2, 'rollback')"); throw failure; })).toThrow(failure);
  expect(() => db.transaction(() => other.transaction(() => 1))).toThrow("nested");
  expect(db.all("SELECT id FROM records")).toEqual([{ id: 1 }]);
});

it("rejects async before execution and rolls back runtime thenables", () => {
  const db = fixture().database; let called = false;
  // @ts-expect-error Async callbacks are outside the synchronous contract.
  expect(() => db.transaction(async () => { called = true; })).toThrow("async");
  expect(called).toBe(false);
  // Simulate an untyped consumer returning a Promise after a synchronous write.
  const work = (() => { db.run("INSERT INTO records VALUES (1, 'pending')"); return Promise.resolve(); }) as unknown as () => void;
  expect(() => db.transaction(work)).toThrow("async");
  expect(db.all("SELECT * FROM records")).toEqual([]);
});

it("preserves the original error when rollback fails", () => {
  const db = fixture().database; const original = new Error("original");
  expect(() => db.transaction(() => { db.exec("ROLLBACK"); throw original; })).toThrow(original);
  expect(original).toHaveProperty("rollbackDiagnostic.stage", "rollback");
});

it("revokes retained statements and tables without exposing connection ownership", () => {
  const owner = fixture(); const scope = owner.scope("module"); const statement = scope.database.prepare("SELECT * FROM records");
  const table = scope.database.table({ name: "records", columns: ["id", "value"], primaryKey: "id" });
  expect(scope.database).not.toHaveProperty("close"); expect(scope.database).not.toHaveProperty("legacy");
  scope.revoke(); expect(() => statement.all()).toThrow("closed"); expect(() => table.findById(1)).toThrow("closed");
  expect(owner.database.all("SELECT * FROM records")).toEqual([]);
});

const baseline = () => {};
const first: ModuleMigration = { version: 1, key: "first", up: (db) => { db.run("INSERT INTO records VALUES (1, 'a')"); } };
it("isolates namespace histories and commits each pending batch atomically", () => {
  const owner = fixture(); const a = owner.scope("capability:company-research").database; const b = owner.scope("base:usage").database;
  a.migrate([first], baseline);
  expect(() => b.migrate([{ version: 1, key: "first", up(db) { db.run("INSERT INTO records VALUES (2, 'b')"); } }, { version: 2, key: "broken", up() { throw new Error("SECRET SQL body"); } }], baseline)).toThrow("base:usage:2:apply");
  expect(owner.database.all("SELECT id FROM records")).toEqual([{ id: 1 }]);
  expect(owner.database.all("SELECT namespace, version FROM module_schema_migrations")).toEqual([{ namespace: "capability:company-research", version: 1 }]);
  owner.scope("app:chat").database.migrate([], baseline);
  a.migrate([first], baseline); // The insert cannot run a second time.
});

it("rejects non-contiguous declarations, changed keys, missing prefix and newer heads including empty lists", () => {
  const db = fixture().database;
  expect(() => db.migrate([{ ...first, version: 2 }], baseline)).toThrow("declaration");
  db.migrate([first], baseline);
  expect(() => db.migrate([{ ...first, key: "changed" }], baseline)).toThrow("ledger");
  expect(() => db.migrate([], baseline)).toThrow("ledger");
  db.run("UPDATE module_schema_migrations SET version = 2");
  expect(() => db.migrate([first, { version: 2, key: "second", up() {} }], baseline)).toThrow("ledger");
});

it("keeps migration diagnostics safe and rolls back baseline failure", () => {
  const db = fixture().database;
  let error: unknown;
  try { db.migrate([], (view) => { view.run("INSERT INTO records VALUES (1, 'secret')"); throw new Error("secret"); }); } catch (caught) { error = caught; }
  expect(error).toHaveProperty("diagnostic", { namespace: "host", version: 0, stage: "baseline", code: undefined });
  expect(String(error)).not.toContain("secret"); expect(error).not.toHaveProperty("cause");
  expect(db.all("SELECT * FROM records")).toEqual([]);
});
