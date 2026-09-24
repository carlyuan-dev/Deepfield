import type {
  LlmRuntimeSnapshot,
  SearchRuntimeSnapshot,
} from "@deepfield/contracts/model-config";
import type { ToolAccessPolicy } from "@deepfield/contracts/tools";

export interface PiExecutionContextMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  requestId?: string;
}

export interface PiExecutionRequest {
  requestId: string;
  prompt: string;
  humanPrompt?: string;
  systemPrompt: string;
  finalizationSystemPrompt?: string;
  skillName?: string;
  search?: SearchRuntimeSnapshot;
  llm: LlmRuntimeSnapshot;
  toolAccess: ToolAccessPolicy;
  contextMessages: PiExecutionContextMessage[];
}

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
      skillName?: string;
      webSearch?: boolean;
    }
  | { requestId: string; type: "text_delta"; delta: string }
  | { requestId: string; type: "text_reset" }
  | PiRegularToolActivityEvent
  | PiUnbilledToolActivityEvent
  | { requestId: string; type: "handed_off" }
  | { requestId: string; type: "completed"; text: string };
