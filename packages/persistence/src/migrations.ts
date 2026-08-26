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
];

export function migrate(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  db.exec("BEGIN IMMEDIATE;");
  try {
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
