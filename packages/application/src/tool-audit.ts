import type {
  ToolAuditFinish,
  ToolAuditSink,
  ToolAuditStart,
} from "@deepfield/tool-platform";
import type { ToolExecutionRepository } from "@deepfield/persistence";

export class SqliteToolAuditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqliteToolAuditError";
  }
}

/**
 * Main-process ToolAuditSink backed by ToolExecutionRepository. Only the
 * whitelisted audit fields are mapped: no input/output/body/keys/headers ever
 * reach the database, summaries stay null (the Runner sink carries none), and
 * a failed write rejects with a sanitized error so the Runner can never claim
 * completed when the audit row was not durably updated.
 */
export class SqliteToolAudit implements ToolAuditSink {
  readonly #repos: ToolExecutionRepository;

  constructor(repos: ToolExecutionRepository) {
    this.#repos = repos;
  }

  async start(record: ToolAuditStart): Promise<void> {
    try {
      this.#repos.start({
        id: record.executionId,
        traceId: record.traceId,
        ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
        actor: record.actor,
        toolName: record.tool.name,
        toolVersion: record.tool.version,
        startedAt: new Date().toISOString(),
      });
    } catch {
      throw new SqliteToolAuditError("failed to persist tool audit start");
    }
  }

  async finish(record: ToolAuditFinish): Promise<void> {
    try {
      this.#repos.finish({
        id: record.executionId,
        status: record.status,
        ...(record.failure !== undefined ? { errorCode: record.failure.code } : {}),
        attempts: record.attempts,
        retries: Math.max(record.attempts - 1, 0),
        bytesReceived: 0,
        resultCount: 0,
        finishedAt: new Date().toISOString(),
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      });
    } catch {
      throw new SqliteToolAuditError("failed to persist tool audit finish");
    }
  }
}
