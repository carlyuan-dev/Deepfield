import type {
  LlmRuntimeSnapshot,
  SearchRuntimeSnapshot,
} from "@deepfield/contracts/model-config";
import type { ToolAccessPolicy } from "@deepfield/contracts/tools";

import type { PiAgentRequest, PiExecutionEvent as BaseExecutionEvent, PiExecutionContextMessage } from "@deepfield/base/agent";
export type { PiExecutionContextMessage, PiToolSource } from "@deepfield/base/agent";

export interface PiExecutionRequest extends Pick<PiAgentRequest, "requestId" | "prompt" | "systemPrompt"> {
  humanPrompt?: string;
  finalizationSystemPrompt?: string;
  skillName?: string;
  search?: SearchRuntimeSnapshot;
  llm: LlmRuntimeSnapshot;
  toolAccess: ToolAccessPolicy;
  contextMessages: PiExecutionContextMessage[];
}

/** Compatibility events add only application presentation metadata. */
export type PiExecutionEvent = Exclude<BaseExecutionEvent, { type: "started" }> | {
  requestId: string;
  type: "started";
  skillName?: string;
  webSearch?: boolean;
};
