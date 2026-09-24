import type { DatabaseSync } from "node:sqlite";

interface Migration {
  version: number;
  up: (db: DatabaseSync) => void;
}

const MIGRATIONS: Migration[] = [
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
  {
    version: 13,
    up(db) {
      db.exec(`
        CREATE TABLE company_research_runs_v13(
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          company_id TEXT NOT NULL,
          schema_version TEXT NOT NULL CHECK(schema_version IN ('legacy-freeform-v1', 'company-research-report-v1')),
          status TEXT NOT NULL CHECK(status IN ('researching', 'research_failed', 'structuring', 'structure_failed', 'completed')),
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
          last_failure_code TEXT CHECK(last_failure_code IS NULL OR last_failure_code IN ('structuring_failed','tool_failed','model_failed','empty_report','protocol_leak','language_validation_failed','incomplete_response','protocol_error','storage_failed')),
          legacy_time_scope TEXT,
          legacy_custom_requirements TEXT,
          legacy_report_text TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          CHECK(schema_version != 'legacy-freeform-v1' OR status = 'completed'),
          CHECK(
            status != 'research_failed' OR (
              raw_report_text IS NULL AND raw_completed_at IS NULL AND structured_content_json IS NULL
              AND structuring_attempts = 0 AND completed_at IS NULL
              AND last_failure_code IS NOT NULL AND last_failure_code != 'structuring_failed'
            )
          ),
          CHECK(
            status != 'structure_failed' OR (
              raw_report_text IS NOT NULL AND raw_completed_at IS NOT NULL
              AND structuring_attempts >= 1
              AND last_failure_code IS NOT NULL AND last_failure_code = 'structuring_failed'
            )
          ),
          FOREIGN KEY(item_id, company_id)
            REFERENCES capability_item_companies(item_id, company_id) ON DELETE CASCADE
        );
        INSERT INTO company_research_runs_v13(
          id, item_id, company_id, schema_version, status, research_direction, focus_scope, as_of_date,
          research_context_json, template_id, template_version, template_snapshot_json, harness_version,
          raw_report_text, raw_completed_at, structured_content_json, structuring_attempts, last_failure_code,
          legacy_time_scope, legacy_custom_requirements, legacy_report_text, created_at, completed_at
        )
        SELECT
          id, item_id, company_id, schema_version, status, research_direction, focus_scope, as_of_date,
          research_context_json, template_id, template_version, template_snapshot_json, harness_version,
          raw_report_text, raw_completed_at, structured_content_json, structuring_attempts, last_failure_code,
          legacy_time_scope, legacy_custom_requirements, legacy_report_text, created_at, completed_at
        FROM company_research_runs;
        DROP TABLE company_research_runs;
        ALTER TABLE company_research_runs_v13 RENAME TO company_research_runs;
        CREATE UNIQUE INDEX idx_company_research_one_active
          ON company_research_runs((1)) WHERE status IN ('researching', 'structuring');
        CREATE INDEX idx_company_research_completed_history
          ON company_research_runs(item_id, company_id, completed_at DESC, id DESC)
          WHERE status IN ('completed', 'research_failed', 'structure_failed');
      `);
    },
  },
  {
    version: 14,
    up(db) {
      db.exec(`ALTER TABLE company_research_runs ADD COLUMN search_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK(search_status IN ('unknown', 'none', 'succeeded'));`);
    },
  },
  { version: 15, up(db) {
    db.exec("ALTER TABLE companies ADD COLUMN profile_provenance_json TEXT; ALTER TABLE companies ADD COLUMN profile_issue_json TEXT;");
  } },
  { version: 16, up(db) {
    db.exec(`CREATE TABLE company_profile_diagnostics(
      request_id TEXT PRIMARY KEY, company_id TEXT NOT NULL, diagnostic_json TEXT NOT NULL,
      created_at TEXT NOT NULL, FOREIGN KEY(company_id) REFERENCES companies(id) ON DELETE CASCADE
    ); CREATE INDEX idx_company_profile_diagnostics_company ON company_profile_diagnostics(company_id, created_at);`);
  } },
  { version: 17, up(db) {
    db.exec("ALTER TABLE companies ADD COLUMN profile_identity_hint_json TEXT;");
  } },
  { version: 18, up(db) {
    db.exec(`
      CREATE TABLE company_research_model_diagnostics_v18(
        diagnostic_id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
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
        error_category TEXT CHECK(error_category IS NULL OR error_category IN ('provider_failed','stream_failed','incomplete_lifecycle','invalid_final_empty','invalid_final_protocol','invalid_final_language','invalid_final_tool_use','json_parse','schema_invalid','shape_invalid','status_invalid','source_mismatch','truncated','storage_failed')),
        attempt INTEGER CHECK(attempt IS NULL OR attempt IN (1,2)),
        validation_issues_json TEXT,
        failed_candidate TEXT CHECK(failed_candidate IS NULL OR length(failed_candidate) <= 16384),
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0)
      );
      INSERT INTO company_research_model_diagnostics_v18(
        request_id, run_id, trace_id, stage, phase, agent_turns, search_calls, fetch_calls,
        max_model_input_chars_estimate, output_chars, stop_reason, error_category, started_at, finished_at, duration_ms
      ) SELECT request_id, run_id, trace_id, stage, phase, agent_turns, search_calls, fetch_calls,
        max_model_input_chars_estimate, output_chars, stop_reason, error_category, started_at, finished_at, duration_ms
        FROM company_research_model_diagnostics;
      DROP TABLE company_research_model_diagnostics;
      ALTER TABLE company_research_model_diagnostics_v18 RENAME TO company_research_model_diagnostics;
      CREATE UNIQUE INDEX idx_company_research_diagnostics_request_attempt ON company_research_model_diagnostics(request_id, COALESCE(attempt, 0));
      CREATE INDEX idx_company_research_diagnostics_trace ON company_research_model_diagnostics(trace_id);
      CREATE INDEX idx_company_research_diagnostics_run ON company_research_model_diagnostics(run_id, started_at, request_id, attempt);
    `);
  } },
];

MIGRATIONS.push({ version: 19, up(db) {
  db.exec(`CREATE TABLE company_research_batches(id TEXT PRIMARY KEY, item_id TEXT NOT NULL, status TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_company_research_batch_active ON company_research_batches((1)) WHERE status NOT IN ('completed','cancelled');`);
} });

MIGRATIONS.push({ version: 20, up(db) {
  // Independent ledger: business/Profile deletion must never cascade into usage.
  db.exec(`CREATE TABLE usage_attempts(
    attempt_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, service_kind TEXT NOT NULL CHECK(service_kind IN ('llm','search')),
    profile_id TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('running','succeeded','failed','cancelled','interrupted')),
    revision INTEGER NOT NULL CHECK(revision >= 0), data_json TEXT NOT NULL
  );
  CREATE INDEX idx_usage_time ON usage_attempts(started_at, attempt_id);
  CREATE INDEX idx_usage_kind_time ON usage_attempts(service_kind, started_at);
  CREATE INDEX idx_usage_profile_time ON usage_attempts(profile_id, started_at);
  CREATE TABLE usage_health(id INTEGER PRIMARY KEY CHECK(id = 1), data_json TEXT NOT NULL);`);
} });

MIGRATIONS.push({ version: 21, up(db) {
  db.exec("ALTER TABLE conversations ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0 CHECK(web_search_enabled IN (0, 1))");
} });

MIGRATIONS.push({ version: 22, up(db) {
  db.exec(`CREATE TABLE chat_sessions(
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL, data_json TEXT NOT NULL,
    PRIMARY KEY(conversation_id, request_id)
  );`);
} });

MIGRATIONS.push({ version: 23, up(db) {
  db.exec(`CREATE TABLE usage_attempt_acknowledgements(
    attempt_id TEXT NOT NULL REFERENCES usage_attempts(attempt_id) ON DELETE CASCADE,
    signature TEXT NOT NULL, acknowledged_at TEXT NOT NULL,
    PRIMARY KEY(attempt_id, signature)
  );
  CREATE TABLE usage_history_acknowledgement(
    id INTEGER PRIMARY KEY CHECK(id = 1), dropped_records INTEGER NOT NULL, interrupted_requests INTEGER NOT NULL
  );`);
} });

MIGRATIONS.push({ version: 24, up(db) {
  db.exec(`CREATE TABLE capability_invocations(
    id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, action_id TEXT NOT NULL,
    binding_digest TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('issued','pending','completed')),
    result_json TEXT, task_id TEXT, terminal_at INTEGER
  );
  CREATE INDEX idx_capability_invocations_task ON capability_invocations(capability_id, task_id);
  CREATE INDEX idx_capability_invocations_retention ON capability_invocations(terminal_at, expires_at);`);
} });

MIGRATIONS.push({ version: 25, up(db) {
  db.exec(`CREATE TABLE company_research_drafts(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE company_research_tasks(id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, finished_at TEXT);
    CREATE INDEX idx_company_research_task_retention ON company_research_tasks(finished_at);`);
} });

MIGRATIONS.push({ version: 26, up(db) {
  db.exec(`CREATE TABLE chat_capability_descriptions(
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    capability_id TEXT NOT NULL, package_version TEXT NOT NULL,
    action_id TEXT NOT NULL, contract_digest TEXT NOT NULL,
    documentation TEXT NOT NULL, declaration_json TEXT NOT NULL,
    PRIMARY KEY(conversation_id, capability_id, package_version, action_id, contract_digest)
  );
  CREATE TABLE chat_capability_tasks(
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    capability_id TEXT NOT NULL, task_id TEXT NOT NULL,
    source_request_id TEXT NOT NULL, snapshot_json TEXT NOT NULL,
    analyze_after INTEGER NOT NULL DEFAULT 0,
    analysis_state TEXT NOT NULL DEFAULT 'none',
    consumed_event_id TEXT,
    PRIMARY KEY(conversation_id, capability_id, task_id)
  );
  CREATE INDEX idx_chat_capability_tasks_ref ON chat_capability_tasks(capability_id, task_id);`);
} });

MIGRATIONS.push({ version: 27, up(db) {
  db.exec(`CREATE TABLE chat_capability_views(
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    target_key TEXT NOT NULL, source_request_id TEXT NOT NULL,
    target_json TEXT NOT NULL,
    PRIMARY KEY(conversation_id, target_key)
  );`);
} });

MIGRATIONS.push({ version: 28, up(db) {
  db.exec(`CREATE TABLE chat_capability_invocations(
    invocation_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_request_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    call_digest TEXT NOT NULL
  );
  CREATE INDEX idx_chat_invocation_binding ON chat_capability_invocations(conversation_id, call_digest);`);
} });

MIGRATIONS.push({ version: 29, up(db) {
  db.exec(`CREATE TABLE chat_capability_operation_cards(
    invocation_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_request_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('awaiting_confirmation','completed','failed','cancelled','interrupted','uncertain')),
    title TEXT NOT NULL,
    presentation_json TEXT
  );
  CREATE INDEX idx_chat_operation_cards_request ON chat_capability_operation_cards(conversation_id, source_request_id);`);
} });

MIGRATIONS.push({ version: 30, up(db) {
  db.exec(`CREATE TABLE chat_interactions(
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_request_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('question','approval')),
    payload_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 1),
    status TEXT NOT NULL CHECK(status IN ('waiting','editing','executing','answered','cancelled','invalidated','submitted','succeeded','failed','uncertain')),
    content_version TEXT,
    receipt_id TEXT UNIQUE,
    answer TEXT,
    result_summary TEXT,
    task_id TEXT,
    failure_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_chat_interactions_one_active ON chat_interactions(conversation_id)
    WHERE status IN ('waiting','editing','executing');
  CREATE INDEX idx_chat_interactions_conversation ON chat_interactions(conversation_id, created_at);
  CREATE TABLE chat_interaction_responses(
    id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL REFERENCES chat_interactions(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
    detail TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(interaction_id, revision)
  );
  CREATE TABLE chat_interaction_resume_events(
    id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL REFERENCES chat_interactions(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    source_request_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','claimed','consumed')),
    created_at TEXT NOT NULL,
    UNIQUE(interaction_id, kind)
  );
  CREATE INDEX idx_chat_interaction_resume_pending ON chat_interaction_resume_events(conversation_id, state, created_at);`);
} });

MIGRATIONS.push({ version: 31, up(db) {
  db.exec(`CREATE TABLE chat_interaction_continuations(
    receipt_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    owner_json TEXT NOT NULL, operation_json TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
  );`);
} });

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
