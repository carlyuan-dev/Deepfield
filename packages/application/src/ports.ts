import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";

export interface SecretReader {
  get(name: string): string | undefined;
}

export interface AgentWorkerPort {
  send(request: AgentWorkerRequest): AsyncIterable<AgentWorkerEvent>;
}

export type RequestIdFactory = () => string;

/** Narrow provider-key reader: only the compiled allowlisted provider. */
export interface ProviderKeyReader {
  getProviderKey(provider: "deepseek"): string | undefined;
}
