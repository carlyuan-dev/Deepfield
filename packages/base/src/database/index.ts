/** SQLite values are explicit: encode booleans/JSON in the owning repository. */
export type SqlValue = null | string | number | bigint | Uint8Array;
export type SqlRow = Record<string, SqlValue>;
export interface RunResult { changes: number | bigint; lastInsertRowid: number | bigint }
export interface Statement {
  get(...values: SqlValue[]): SqlRow | undefined;
  all(...values: SqlValue[]): SqlRow[];
  run(...values: SqlValue[]): RunResult;
}
export interface TableDefinition { readonly name: string; readonly columns: readonly string[]; readonly primaryKey: string }
export interface Table {
  findById(id: SqlValue): SqlRow | undefined;
  insert(values: Readonly<Record<string, SqlValue>>): RunResult;
  update(where: Readonly<Record<string, SqlValue>>, patch: Readonly<Record<string, SqlValue>>): RunResult;
  delete(where: Readonly<Record<string, SqlValue>>): RunResult;
}
export interface ModuleMigration { readonly version: number; readonly key: string; readonly up: (db: Database) => void }
export interface Database {
  readonly version: 1;
  prepare(sql: string): Statement;
  get(sql: string, ...values: SqlValue[]): SqlRow | undefined;
  all(sql: string, ...values: SqlValue[]): SqlRow[];
  run(sql: string, ...values: SqlValue[]): RunResult;
  /** Trusted SQL, not a table-level security sandbox. */
  exec(sql: string): void;
  transaction<T>(work: () => T extends PromiseLike<unknown> ? never : T): T;
  table(definition: TableDefinition): Table;
  /** Namespace is bound by the host, never selected by a consumer. */
  migrate(migrations: readonly ModuleMigration[], checkBaseline: (db: Database) => void): void;
}

export function assertDatabase(value: unknown): asserts value is Database {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
    ["prepare", "get", "all", "run", "exec", "transaction", "table", "migrate"].some(key => typeof (value as Record<string, unknown>)[key] !== "function")) throw new Error("incompatible_host_service:database.v1");
}
