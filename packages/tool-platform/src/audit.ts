import type { ToolIdentity } from "@deepfield/contracts";
import type { ToolFailure } from "./errors.js";

/** Whitelisted audit start summary: no input, output, progress, secret or headers. */
export interface ToolAuditStart {
  executionId: string;
  traceId: string;
  projectId?: string;
  actor: string;
  tool: ToolIdentity;
  attempts: number;
}

export interface ToolAuditFinish {
  executionId: string;
  traceId: string;
  status: "completed" | "failed" | "cancelled";
  attempts: number;
  failure?: ToolFailure;
  durationMs?: number;
}

export interface ToolAuditSink {
  start(record: ToolAuditStart): Promise<void>;
  finish(record: ToolAuditFinish): Promise<void>;
}
