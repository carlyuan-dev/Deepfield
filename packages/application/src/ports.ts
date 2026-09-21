import type { AgentWorkerEvent, AgentWorkerRequest, LlmRuntimeSnapshot, SearchRuntimeSnapshot } from "@deepfield/contracts";
import type { CompanyResearchWorkerEvent, CompanyResearchWorkerRequest, CompanyResearchStage, CompanyDraft, Company, CompanyProfileResult, CompanyProfileWorkerRequest, CompanyProfileWorkerEvent } from "../../../capabilities/company-research/contracts/index.js";

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

export interface CompanyProfileWorkerPort {
  sendProfile(request: CompanyProfileWorkerRequest): AsyncIterable<CompanyProfileWorkerEvent>;
}
export interface CompanyProfileCompleter {
  /** Resolve immutable active configuration before claiming a pending company. */
  prepare(company: Company, researchTopics: string[]): Promise<() => Promise<CompanyProfileResult>>;
}

export type RequestIdFactory = () => string;

/** Narrow provider-key reader: only the compiled allowlisted provider. */
export interface ProviderKeyReader {
  getProviderKey(provider: "deepseek"): string | undefined;
}
