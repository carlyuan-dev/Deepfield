import type {
  AgentWorkerEvent,
  AgentWorkerRequest,
  CompanyResearchWorkerEvent,
  CompanyResearchWorkerRequest,
  CompanyResearchStage,
  ToolExecutionEvent,
  ToolRunRequest,
} from "@deepfield/contracts";

export interface ChatAgent {
  run(
    request: AgentWorkerRequest,
    emit: (event: AgentWorkerEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface ResearchAgent {
  run(
    request: CompanyResearchWorkerRequest,
    emit: (event: CompanyResearchWorkerEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

/** Keep both failure variants literal so the stage-discriminated contract holds. */
export function researchFailure(stage: CompanyResearchStage) {
  return stage === "raw"
    ? { stage: "raw", code: "research_failed", message: "company research failed" } as const
    : { stage: "structure", code: "structuring_failed", message: "company research structuring failed" } as const;
}

/** Tool executions are routed to a trusted Utility-side runtime. */
export interface ToolRuntime {
  run(
    request: ToolRunRequest,
    emit: (event: ToolExecutionEvent) => void,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface WorkerEndpoint {
  postMessage(value: unknown): void;
  onMessage(listener: (value: unknown) => void): () => void;
}

export interface WorkerLoop {
  dispose(): void;
  activeCount(): number;
}

export interface ActiveExecution {
  kind: "chat" | "research" | "tool";
  requestId: string;
  runId?: string;
  stage?: CompanyResearchStage;
  executionId?: string;
  traceId?: string;
  tool?: { name: string; version: number };
  controller: AbortController;
  settled: boolean;
  settle: (code: string, message: string, abortSignal: boolean) => void;
  finalize: () => void;
}

export function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const requestId = (value as { requestId?: unknown }).requestId;
  if (typeof requestId === "string") {
    return requestId;
  }
  return undefined;
}

export function isHostReply(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { hostRequestId?: unknown; kind?: unknown };
  return (
    typeof record.hostRequestId === "string" &&
    record.hostRequestId.length > 0 &&
    record.kind === "host.reply"
  );
}

export function toolEnvelope(
  requestId: string,
  event: ToolExecutionEvent,
): { kind: "tool.event"; requestId: string; event: ToolExecutionEvent } {
  return { kind: "tool.event", requestId, event };
}

/** Safe tool-protocol terminal envelope (never a chat-shaped failed event). */
export function toolFailedEnvelope(
  requestId: string,
  executionId: string,
  traceId: string,
  tool: { name: string; version: number },
  code: string,
  message: string,
  timestamp: number,
): { kind: "tool.event"; requestId: string; event: ToolExecutionEvent } {
  return {
    kind: "tool.event",
    requestId,
    event: {
      executionId,
      traceId,
      tool,
      sequence: 0,
      timestamp,
      type: "failed",
      failure: { code, message, retryable: false, attempts: 1 },
    },
  };
}
