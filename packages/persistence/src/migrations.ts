import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE projects(
          id TEXT PRIMARY KEY, industry TEXT NOT NULL, scope_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('draft')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE conversations(
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
          has_user_message INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE TABLE messages(
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')),
          content TEXT NOT NULL, created_at TEXT NOT NULL,
          FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE TABLE project_activity_events(
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
          type TEXT NOT NULL, source TEXT NOT NULL, importance TEXT NOT NULL,
          summary TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE tool_executions(
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          project_id TEXT,
          actor TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
          input_summary_json TEXT,
          output_summary_json TEXT,
          error_code TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          retries INTEGER NOT NULL DEFAULT 0,
          bytes_received INTEGER NOT NULL DEFAULT 0,
          result_count INTEGER NOT NULL DEFAULT 0,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          duration_ms INTEGER
        );
        CREATE INDEX idx_tool_executions_trace_id ON tool_executions(trace_id);
        CREATE INDEX idx_tool_executions_project_id ON tool_executions(project_id);
        CREATE INDEX idx_tool_executions_started_at_id ON tool_executions(started_at, id);
      `);
    },
  },
];

export function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
    );
    const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = ?");
    const record = db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
    );
    for (const migration of MIGRATIONS) {
      if (applied.get(migration.version)) {
        continue;
      }
      migration.up(db);
      record.run(migration.version, new Date().toISOString());
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
