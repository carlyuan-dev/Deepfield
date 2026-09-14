import type { ToolIdentity, ToolSyntheticAuditRecord } from "@deepfield/contracts";
import type { ToolFailure } from "./errors.js";

/** Whitelisted audit start summary: no input, output, progress, secret or headers. */
export interface ToolAuditStart {
  executionId: string;
  traceId: string;
  projectId?: string;
  actor: string;
  tool: ToolIdentity;
  attempts: number;
  agentTurnIndex?: number;
  batchId?: string;
  toolCallId?: string;
}

export interface ToolAuditFinish {
  executionId: string;
  traceId: string;
  status: "completed" | "failed" | "cancelled";
  attempts: number;
  budgetConsumed: boolean;
  failure?: ToolFailure;
  durationMs?: number;
}

export interface ToolAuditSink {
  start(record: ToolAuditStart): Promise<void>;
  finish(record: ToolAuditFinish): Promise<void>;
  /** Persists a terminal call that was deliberately never dispatched. */
  recordSynthetic?(record: ToolSyntheticAuditRecord): Promise<void>;
}
