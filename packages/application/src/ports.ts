import type {
  AgentWorkerEvent,
  AgentWorkerRequest,
  CompanyResearchWorkerEvent,
  CompanyResearchWorkerRequest,
  CompanyResearchStage,
  CompanyDraft,
  CompanyProfileFields,
  LlmRuntimeSnapshot,
  SearchRuntimeSnapshot,
} from "@deepfield/contracts";

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

export interface CompanyResearchWorkerPort {
  sendResearch(request: CompanyResearchWorkerRequest): AsyncIterable<CompanyResearchWorkerEvent>;
  cancelResearch(requestId: string, runId: string, stage: CompanyResearchStage): void;
}

export interface ConversationTitleGenerator {
  generateConversationTitle(content: string): Promise<string | undefined>;
}

export interface CompanyRecognizer {
  recognize(text: string): Promise<CompanyDraft[]>;
}

export interface CompanyCompletionContext {
  researchTopics?: string[];
}

export interface CompanyCompleter {
  complete(name: string, context?: CompanyCompletionContext): Promise<CompanyProfileFields>;
}

export type RequestIdFactory = () => string;

/** Narrow provider-key reader: only the compiled allowlisted provider. */
export interface ProviderKeyReader {
  getProviderKey(provider: "deepseek"): string | undefined;
}
