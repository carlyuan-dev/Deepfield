import { DatabaseSync } from "node:sqlite";
import type { Database, ModuleMigration, SqlValue, Statement, Table, TableDefinition } from "./index.js";

function integer(value: number | bigint): number | bigint {
  return typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function values(input: readonly unknown[]): asserts input is readonly SqlValue[] {
  for (const value of input) {
    if (value === null || typeof value === "string" || typeof value === "bigint" || value instanceof Uint8Array) continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    throw new TypeError("database_invalid_binding");
  }
}
function identifier(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new TypeError("database_invalid_identifier");
  return `"${value}"`;
}
function driverCode(error: unknown): string | undefined {
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && /^(?:ERR_SQLITE_[A-Z_]+|SQLITE_[A-Z_]+)$/.test(code) ? code : undefined;
  } catch { return undefined; }
}
function synchronous<T>(work: () => T): T {
  if (Object.prototype.toString.call(work) === "[object AsyncFunction]") throw new TypeError("database_async_transaction");
  const result = work();
  if (result !== null && (typeof result === "object" || typeof result === "function") && "then" in result && typeof result.then === "function") {
    // Observe rejection without allowing the result to become a successful commit.
    void Promise.resolve(result).catch(() => {});
    throw new TypeError("database_async_transaction");
  }
  return result;
}
export interface DatabaseScope { readonly database: Database; revoke(): void }
export interface DatabaseOwner {
  readonly database: Database;
  scope(namespace: string): DatabaseScope;
  close(): void;
  /** Trusted host compatibility only; never supplied to a Capability. */
  legacy<T>(work: (native: DatabaseSync) => T): T;
}
const owners = new WeakMap<DatabaseSync, DatabaseOwner>();

/** Adopt a host-owned connection without opening another file/connection. */
export function adoptDatabase(native: DatabaseSync): DatabaseOwner {
  const existing = owners.get(native);
  if (existing) return existing;
  let closed = false;
  let inTransaction = false;
  function scope(namespace: string): DatabaseScope {
    if (typeof namespace !== "string" || namespace.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::[a-zA-Z0-9][a-zA-Z0-9._-]*)?$/.test(namespace)) throw new TypeError("database_invalid_namespace");
    let revoked = false;
    function assertActive() { if (closed || revoked) throw new Error("database_scope_closed"); }
    const database: Database = Object.freeze({
      version: 1 as const,
      prepare(sql: string): Statement {
        assertActive();
        const statement = native.prepare(sql);
        return Object.freeze({
          get(...input: SqlValue[]) { assertActive(); values(input); return statement.get(...input); },
          all(...input: SqlValue[]) { assertActive(); values(input); return statement.all(...input); },
          run(...input: SqlValue[]) {
            assertActive(); values(input);
            // The default driver rounds large rowids. Preserve their exact bigint
            // value while keeping historical number results for safe integers.
            statement.setReadBigInts(true);
            try { const result = statement.run(...input); return { changes: integer(result.changes), lastInsertRowid: integer(result.lastInsertRowid) }; }
            finally { statement.setReadBigInts(false); }
          },
        });
      },
      get(sql: string, ...input: SqlValue[]) { return database.prepare(sql).get(...input); },
      all(sql: string, ...input: SqlValue[]) { return database.prepare(sql).all(...input); },
      run(sql: string, ...input: SqlValue[]) { return database.prepare(sql).run(...input); },
      exec(sql: string) { assertActive(); native.exec(sql); },
      transaction<T>(work: () => T): T {
        assertActive();
        if (inTransaction || native.isTransaction) throw new Error("database_nested_transaction");
        if (Object.prototype.toString.call(work) === "[object AsyncFunction]") throw new TypeError("database_async_transaction");
        native.exec("BEGIN IMMEDIATE");
        inTransaction = true;
        try {
          const result = synchronous(work);
          assertActive();
          native.exec("COMMIT");
          return result;
        } catch (error) {
          try { native.exec("ROLLBACK"); } catch (rollbackError) {
            // Keep the original thrown value and attach only a safe driver classification.
            try {
              if (error instanceof Error && Object.isExtensible(error)) Object.defineProperty(error, "rollbackDiagnostic", { value: Object.freeze({ stage: "rollback", code: driverCode(rollbackError) }), configurable: true });
            } catch { /* A frozen/custom error must not replace the original failure. */ }
          }
          throw error;
        } finally { inTransaction = false; }
      },
      table(definition: TableDefinition): Table { assertActive(); return table(database, definition); },
      migrate(migrations: readonly ModuleMigration[], baseline: (db: Database) => void) { assertActive(); migrate(database, namespace, migrations, baseline); },
    });
    return Object.freeze({ database, revoke() { revoked = true; } });
  }
  const owner: DatabaseOwner = Object.freeze({
    database: scope("host").database,
    scope,
    close() { if (!closed) { native.close(); closed = true; } },
    legacy<T>(work: (db: DatabaseSync) => T): T { if (closed) throw new Error("database_scope_closed"); return work(native); },
  });
  owners.set(native, owner);
  return owner;
}
export function openDatabase(path: string): DatabaseOwner {
  const native = new DatabaseSync(path);
  try { native.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;"); return adoptDatabase(native); }
  catch (error) { native.close(); throw error; }
}

function table(db: Database, input: TableDefinition): Table {
  const definition = Object.freeze({ name: input.name, columns: Object.freeze([...input.columns]), primaryKey: input.primaryKey });
  const name = identifier(definition.name);
  const columns = new Set(definition.columns);
  if (columns.size !== definition.columns.length || !columns.has(definition.primaryKey)) throw new TypeError("database_invalid_table");
  definition.columns.forEach(identifier);
  function entries(record: Readonly<Record<string, SqlValue>>) {
    const pairs = Object.entries(record);
    if (!pairs.length) throw new TypeError("database_empty_record");
    for (const [key, value] of pairs) { if (!columns.has(key)) throw new TypeError("database_unknown_column"); values([value]); }
    return pairs;
  }
  function condition(record: Readonly<Record<string, SqlValue>>) {
    const pairs = entries(record);
    return { sql: pairs.map(([key, value]) => `${identifier(key)} ${value === null ? "IS NULL" : "= ?"}`).join(" AND "), values: pairs.filter(([, value]) => value !== null).map(([, value]) => value) };
  }
  return Object.freeze({
    findById(id: SqlValue) { return db.get(`SELECT * FROM ${name} WHERE ${identifier(definition.primaryKey)} = ?`, id); },
    insert(record: Readonly<Record<string, SqlValue>>) { const pairs = entries(record); return db.run(`INSERT INTO ${name} (${pairs.map(([key]) => identifier(key)).join(", ")}) VALUES (${pairs.map(() => "?").join(", ")})`, ...pairs.map(([, value]) => value)); },
    update(where: Readonly<Record<string, SqlValue>>, patch: Readonly<Record<string, SqlValue>>) { const pairs = entries(patch); const filter = condition(where); return db.run(`UPDATE ${name} SET ${pairs.map(([key]) => `${identifier(key)} = ?`).join(", ")} WHERE ${filter.sql}`, ...pairs.map(([, value]) => value), ...filter.values); },
    delete(where: Readonly<Record<string, SqlValue>>) { const filter = condition(where); return db.run(`DELETE FROM ${name} WHERE ${filter.sql}`, ...filter.values); },
  });
}

function migrate(db: Database, namespace: string, input: readonly ModuleMigration[], baseline: (db: Database) => void): void {
  let version = 0;
  let stage = "declaration";
  try {
    const migrations = input.map((migration) => ({ ...migration }));
    const keys = new Set<string>();
    migrations.forEach((migration, index) => {
      version = migration.version;
      if (version !== index + 1 || typeof migration.key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(migration.key) || keys.has(migration.key)) throw new Error("database_invalid_migrations");
      keys.add(migration.key);
    });
    stage = "transaction";
    db.transaction(() => {
      stage = "baseline"; version = 0;
      synchronous(baseline.bind(undefined, db));
      stage = "ledger";
      db.exec("CREATE TABLE IF NOT EXISTS module_schema_migrations(namespace TEXT NOT NULL, version INTEGER NOT NULL, migration_key TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY(namespace, version), UNIQUE(namespace, migration_key))");
      const applied = db.all("SELECT version, migration_key FROM module_schema_migrations WHERE namespace = ? ORDER BY version", namespace);
      applied.forEach((row, index) => {
        version = Number(row.version);
        if (row.version !== index + 1 || migrations[index]?.version !== row.version || migrations[index]?.key !== row.migration_key) throw new Error("database_migration_history_mismatch");
      });
      for (const migration of migrations.slice(applied.length)) {
        version = migration.version; stage = "apply";
        synchronous(migration.up.bind(undefined, db));
        stage = "record";
        db.run("INSERT INTO module_schema_migrations(namespace, version, migration_key, applied_at) VALUES (?, ?, ?, ?)", namespace, version, migration.key, new Date().toISOString());
      }
    });
  } catch (error) {
    // Driver messages can contain SQL/data; deliberately do not expose a cause.
    const failure = new Error(`database_migration_failed:${namespace}:${version}:${stage}`);
    Object.defineProperty(failure, "diagnostic", { value: Object.freeze({ namespace, version, stage, code: driverCode(error) }) });
    throw failure;
  }
}
