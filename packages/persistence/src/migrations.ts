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
  {
    // Development migration: standalone Conversations no longer belong to a
    // Project. The user approved discarding current test conversations, so the
    // two Chat tables are rebuilt without project references.
    version: 3,
    up(db) {
      db.exec(`
        DROP TABLE messages;
        DROP TABLE conversations;
        CREATE TABLE conversations(
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          has_user_message INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE messages(
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')),
          content TEXT NOT NULL, created_at TEXT NOT NULL,
          FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_messages_conversation_id ON messages(conversation_id, created_at);
        CREATE INDEX idx_conversations_recent ON conversations(has_user_message, updated_at);
      `);
    },
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        DROP TABLE project_activity_events;
        DROP TABLE projects;
        CREATE TABLE capability_items(
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('industry-research')),
          industry TEXT NOT NULL,
          research_scope TEXT,
          notes TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE companies(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL UNIQUE,
          country_or_region TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE capability_item_companies(
          item_id TEXT NOT NULL,
          company_id TEXT NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(item_id, company_id),
          FOREIGN KEY(item_id) REFERENCES capability_items(id) ON DELETE CASCADE,
          FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_capability_items_updated_at
          ON capability_items(updated_at, id);
        CREATE INDEX idx_capability_item_companies_company_id
          ON capability_item_companies(company_id, item_id);
      `);
    },
  },
  {
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE company_research_runs(
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          company_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','completed')),
          time_scope TEXT NOT NULL CHECK(length(trim(time_scope)) > 0 AND length(time_scope) <= 300),
          custom_requirements TEXT CHECK(custom_requirements IS NULL OR length(custom_requirements) <= 4000),
          report_text TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY(item_id, company_id)
            REFERENCES capability_item_companies(item_id, company_id)
            ON DELETE CASCADE,
          CHECK(
            (status = 'running' AND report_text IS NULL AND completed_at IS NULL)
            OR
            (status = 'completed' AND length(trim(report_text)) > 0 AND completed_at IS NOT NULL)
          )
        );
        CREATE UNIQUE INDEX idx_company_research_one_running
          ON company_research_runs(status)
          WHERE status = 'running';
        CREATE INDEX idx_company_research_completed_history
          ON company_research_runs(item_id, company_id, completed_at DESC, id DESC)
          WHERE status = 'completed';
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
