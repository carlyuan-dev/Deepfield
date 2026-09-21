import type { AgentWorkerEvent, AgentWorkerRequest, LlmRuntimeSnapshot, SearchRuntimeSnapshot } from "@deepfield/contracts";

export interface SecretReader {
  get(name: string): string | undefined;
}

export interface RuntimeProfileResolver {
  resolveActiveLlm(): Promise<LlmRuntimeSnapshot>;
  resolveActiveSearch(): Promise<SearchRuntimeSnapshot>;
}

export interface AgentWorkerPort {
  send(request: AgentWorkerRequest): AsyncIterable<AgentWorkerEvent>;
}

export interface ConversationTitleGenerator {
  generateConversationTitle(content: string): Promise<string | undefined>;
}

export type RequestIdFactory = () => string;

/** Narrow provider-key reader: only the compiled allowlisted provider. */
export interface ProviderKeyReader {
  getProviderKey(provider: "deepseek"): string | undefined;
}
