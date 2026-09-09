import type {
  AgentWorkerEvent,
  AgentWorkerRequest,
  CompanyDraft,
} from "@deepfield/contracts";

export interface SecretReader {
  get(name: string): string | undefined;
}

export interface AgentWorkerPort {
  send(request: AgentWorkerRequest): AsyncIterable<AgentWorkerEvent>;
}

export interface ConversationTitleGenerator {
  generateConversationTitle(content: string): Promise<string | undefined>;
}

export interface CompanyRecognizer {
  recognize(text: string): Promise<CompanyDraft[]>;
}

export type RequestIdFactory = () => string;

/** Narrow provider-key reader: only the compiled allowlisted provider. */
export interface ProviderKeyReader {
  getProviderKey(provider: "deepseek"): string | undefined;
}
