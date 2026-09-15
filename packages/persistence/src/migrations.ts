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
  {
    version: 6,
    up(db) {
      db.exec(`
        ALTER TABLE companies ADD COLUMN legal_name TEXT;
        ALTER TABLE companies ADD COLUMN aliases_json TEXT;
        ALTER TABLE companies ADD COLUMN headquarters TEXT;
        ALTER TABLE companies ADD COLUMN founded_at TEXT;
        ALTER TABLE companies ADD COLUMN official_website_json TEXT;
        ALTER TABLE companies ADD COLUMN stock_listings_json TEXT;
        ALTER TABLE companies ADD COLUMN business_tags_json TEXT;
        UPDATE companies
          SET headquarters = country_or_region
          WHERE country_or_region IS NOT NULL AND headquarters IS NULL;
      `);
    },
  },
  {
    version: 7,
    up(db) {
      db.exec(`
        ALTER TABLE companies ADD COLUMN profile_status TEXT NOT NULL DEFAULT 'ready'
          CHECK(profile_status IN ('pending', 'enriching', 'ready', 'failed'));
        CREATE INDEX idx_companies_profile_queue
          ON companies(profile_status, created_at, id);
      `);
    },
  },
  {
    version: 8,
    up(db) {
      db.exec(`
        CREATE TABLE company_research_runs_v8(
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          company_id TEXT NOT NULL,
          schema_version TEXT NOT NULL CHECK(schema_version IN ('legacy-freeform-v1', 'company-research-report-v1')),
          status TEXT NOT NULL CHECK(status IN ('researching', 'structuring', 'structure_failed', 'completed')),
          research_direction TEXT,
          focus_scope TEXT,
          as_of_date TEXT,
          research_context_json TEXT,
          template_id TEXT,
          template_version INTEGER,
          template_snapshot_json TEXT,
          harness_version INTEGER,
          raw_report_text TEXT,
          raw_completed_at TEXT,
          structured_content_json TEXT,
          structuring_attempts INTEGER NOT NULL DEFAULT 0 CHECK(structuring_attempts >= 0),
          last_failure_code TEXT CHECK(last_failure_code IS NULL OR last_failure_code = 'structuring_failed'),
          legacy_time_scope TEXT,
          legacy_custom_requirements TEXT,
          legacy_report_text TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          FOREIGN KEY(item_id, company_id)
            REFERENCES capability_item_companies(item_id, company_id) ON DELETE CASCADE
        );
        INSERT INTO company_research_runs_v8(
          id, item_id, company_id, schema_version, status,
          legacy_time_scope, legacy_custom_requirements, legacy_report_text,
          created_at, completed_at
        )
        SELECT id, item_id, company_id, 'legacy-freeform-v1', 'completed',
          time_scope, custom_requirements, report_text, created_at, completed_at
        FROM company_research_runs WHERE status = 'completed';
        DROP TABLE company_research_runs;
        ALTER TABLE company_research_runs_v8 RENAME TO company_research_runs;
        CREATE UNIQUE INDEX idx_company_research_one_active
          ON company_research_runs((1)) WHERE status IN ('researching', 'structuring');
        CREATE INDEX idx_company_research_completed_history
          ON company_research_runs(item_id, company_id, completed_at DESC, id DESC)
          WHERE status IN ('completed', 'structure_failed');
      `);
    },
  },
  {
    version: 9,
    up(db) {
      const messagesTable = db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'messages'")
        .get();
      if (messagesTable === undefined) {
        return;
      }
      db.exec(`
        ALTER TABLE messages ADD COLUMN request_id TEXT;
        CREATE INDEX idx_messages_request_id ON messages(request_id);
      `);
    },
  },
  {
    version: 10,
    up(db) {
      const toolExecutionsTable = db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tool_executions'")
        .get();
      if (toolExecutionsTable === undefined) {
        return;
      }
      db.exec(`
        CREATE TABLE tool_executions_v10(
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          project_id TEXT,
          actor TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','skipped','reused')),
          agent_turn_index INTEGER,
          batch_id TEXT,
          tool_call_id TEXT,
          budget_consumed INTEGER DEFAULT 0 CHECK(budget_consumed IS NULL OR budget_consumed IN (0,1)),
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
        INSERT INTO tool_executions_v10(
          id, trace_id, project_id, actor, tool_name, tool_version, status,
          input_summary_json, output_summary_json, error_code, attempts, retries,
          bytes_received, result_count, started_at, finished_at, duration_ms
        )
        SELECT
          id, trace_id, project_id, actor, tool_name, tool_version, status,
          input_summary_json, output_summary_json, error_code, attempts, retries,
          bytes_received, result_count, started_at, finished_at, duration_ms
        FROM tool_executions;
        DROP TABLE tool_executions;
        ALTER TABLE tool_executions_v10 RENAME TO tool_executions;
        CREATE INDEX idx_tool_executions_trace_id ON tool_executions(trace_id);
        CREATE INDEX idx_tool_executions_project_id ON tool_executions(project_id);
        CREATE INDEX idx_tool_executions_started_at_id ON tool_executions(started_at, id);
      `);
    },
  },
  {
    version: 11,
    up(db) {
      const toolExecutionsTable = db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'tool_executions'")
        .get();
      if (toolExecutionsTable === undefined) return;
      // v10 backfilled every legacy row with 0 even though no authoritative
      // dispatch fact existed. Preserve that uncertainty for unscoped rows;
      // all new writes remain explicitly 0/1 through the repository.
      db.exec(`
        CREATE TABLE tool_executions_v11(
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          project_id TEXT,
          actor TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_version INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','skipped','reused')),
          agent_turn_index INTEGER,
          batch_id TEXT,
          tool_call_id TEXT,
          budget_consumed INTEGER DEFAULT 0 CHECK(budget_consumed IS NULL OR budget_consumed IN (0,1)),
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
        INSERT INTO tool_executions_v11(
          id, trace_id, project_id, actor, tool_name, tool_version, status,
          agent_turn_index, batch_id, tool_call_id, budget_consumed,
          input_summary_json, output_summary_json, error_code, attempts, retries,
          bytes_received, result_count, started_at, finished_at, duration_ms
        )
        SELECT
          id, trace_id, project_id, actor, tool_name, tool_version, status,
          agent_turn_index, batch_id, tool_call_id,
          CASE
            WHEN budget_consumed = 0
              AND agent_turn_index IS NULL
              AND batch_id IS NULL
              AND tool_call_id IS NULL
            THEN NULL
            ELSE budget_consumed
          END,
          input_summary_json, output_summary_json, error_code, attempts, retries,
          bytes_received, result_count, started_at, finished_at, duration_ms
        FROM tool_executions;
        DROP TABLE tool_executions;
        ALTER TABLE tool_executions_v11 RENAME TO tool_executions;
        CREATE INDEX idx_tool_executions_trace_id ON tool_executions(trace_id);
        CREATE INDEX idx_tool_executions_project_id ON tool_executions(project_id);
        CREATE INDEX idx_tool_executions_started_at_id ON tool_executions(started_at, id);
      `);
    },
  },
  {
    version: 12,
    up(db) {
      // Deliberately detached from company_research_runs: failed raw runs are
      // deleted, while their bounded model diagnostics must remain inspectable.
      db.exec(`
        CREATE TABLE company_research_model_diagnostics(
          request_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          stage TEXT NOT NULL CHECK(stage IN ('raw','structure')),
          phase TEXT NOT NULL CHECK(phase IN ('deciding','synthesizing','structuring')),
          agent_turns INTEGER NOT NULL CHECK(agent_turns >= 0),
          search_calls INTEGER NOT NULL CHECK(search_calls >= 0),
          fetch_calls INTEGER NOT NULL CHECK(fetch_calls >= 0),
          max_model_input_chars_estimate INTEGER NOT NULL CHECK(max_model_input_chars_estimate >= 0),
          output_chars INTEGER NOT NULL CHECK(output_chars >= 0),
          stop_reason TEXT NOT NULL CHECK(stop_reason IN ('stop','length','tool_use','error','aborted','unknown')),
          error_category TEXT CHECK(error_category IS NULL OR error_category IN ('provider_failed','stream_failed','incomplete_lifecycle','invalid_final_empty','invalid_final_protocol','invalid_final_language','invalid_final_tool_use')),
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0)
        );
        CREATE INDEX idx_company_research_diagnostics_trace ON company_research_model_diagnostics(trace_id);
        CREATE INDEX idx_company_research_diagnostics_run ON company_research_model_diagnostics(run_id, started_at, request_id);
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
