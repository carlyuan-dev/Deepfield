import type { AgentWorkerRequest, ChatMemorySnapshot } from "@deepfield/contracts";

/** Chat owns acquisition timing; the host binds storage, identity and model access. */
export interface ChatMemoryPort {
  prepare(request: AgentWorkerRequest): ChatMemorySnapshot | undefined;
  completed(requestId: string): void;
  finished(requestId: string): void;
  userActivity(): void;
}
