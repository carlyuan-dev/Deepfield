export { PiAgentError } from "./errors.js";

export interface PiExecutionContextMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  requestId?: string;
}

/** Safe run identity and limits; model sessions and tools enter through /runtime. */
export interface PiAgentRequest {
  requestId: string;
  prompt: string;
  systemPrompt: string;
  maxAgentTurns: number;
}

export interface AgentHandoff { isRequested(): boolean; }

export interface PiToolSource {
  url: string;
  title: string;
}

interface PiToolActivityFields {
  requestId: string;
  type: "tool_activity";
  callKey: string;
  name: string;
  summary?: string;
  queryOrUrl?: string;
  sources?: PiToolSource[];
  resultCount?: number;
  durationMs?: number;
  errorCode?: string;
  agentTurnIndex?: number;
  batchId?: string;
  toolCallId?: string;
}

type PiRegularToolActivityEvent = PiToolActivityFields & {
  status: "running" | "completed" | "failed";
  budgetConsumed?: boolean;
};

type PiUnbilledToolActivityEvent = PiToolActivityFields & {
  status: "skipped" | "reused";
  budgetConsumed: false;
};

export type PiExecutionEvent =
  | {
      requestId: string;
      type: "started";
    }
  | { requestId: string; type: "text_delta"; delta: string }
  | { requestId: string; type: "text_reset" }
  | PiRegularToolActivityEvent
  | PiUnbilledToolActivityEvent
  | { requestId: string; type: "handed_off" }
  | { requestId: string; type: "completed"; text: string };
