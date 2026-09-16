import type {
  AgentWorkerEvent,
  CompanyProfileWorkerEvent,
  CompanyResearchWorkerEvent,
  CompanyResearchStage,
  ToolEventEnvelope,
  ToolExecutionEvent,
} from "@deepfield/contracts";

export const MAX_PENDING_CHAT_EVENTS = 1000;
export const MAX_PENDING_RESEARCH_EVENTS = 1000;
export const MAX_PENDING_TOOL_EVENTS = 1000;
export const MAX_RECENT_TRANSPORT_IDS = 256;

export class AgentProtocolError extends Error {
  constructor() {
    super("agent worker sent an invalid protocol event");
    this.name = "AgentProtocolError";
  }
}

export class AgentWorkerExitedError extends Error {
  constructor(exitCode: number) {
    super(`agent worker exited unexpectedly with code ${exitCode}`);
    this.name = "AgentWorkerExitedError";
  }
}

export class AgentWorkerQueueOverflowError extends Error {
  constructor() {
    super("agent worker event queue overflow");
    this.name = "AgentWorkerQueueOverflowError";
  }
}

export class AgentWorkerTransportReuseError extends Error {
  constructor() {
    super("transport request id was already used; use a fresh id");
    this.name = "AgentWorkerTransportReuseError";
  }
}

/** Bounded tombstone registry for tool transport ids (exactly-once per close). */
export class ToolTransportTombstones {
  readonly #recent = new Set<string>();

  record(id: string): void {
    this.#recent.add(id);
    if (this.#recent.size > MAX_RECENT_TRANSPORT_IDS) {
      const oldest = this.#recent.values().next().value;
      if (oldest !== undefined) {
        this.#recent.delete(oldest);
      }
    }
  }

  has(id: string): boolean {
    return this.#recent.has(id);
  }
}

export type StreamEvent = AgentWorkerEvent | CompanyResearchWorkerEvent | ToolExecutionEvent | CompanyProfileWorkerEvent;

export interface PendingStream {
  kind: "chat" | "research" | "tool" | "profile";
  companyId?: string;
  id: string;
  runId?: string;
  stage?: CompanyResearchStage;
  executionId?: string;
  traceId?: string;
  queue: StreamEvent[];
  waiters: Array<{
    resolve: (result: IteratorResult<StreamEvent>) => void;
    reject: (error: Error) => void;
  }>;
  error: Error | undefined;
  terminalSeen: boolean;
}

export function isChatTerminal(event: StreamEvent): boolean {
  return event.type === "completed" || event.type === "failed";
}

export function isToolTerminal(event: StreamEvent): boolean {
  return event.type === "completed" || event.type === "failed" || event.type === "cancelled";
}

export function isResearchTerminal(event: StreamEvent): boolean {
  return event.type === "completed" || event.type === "failed" || event.type === "cancelled";
}

export function isHostRequest(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { hostRequestId?: unknown; kind?: unknown };
  return (
    typeof record.hostRequestId === "string" &&
    record.hostRequestId.length > 0 &&
    record.kind === "host.request"
  );
}

export function isToolEventEnvelope(value: unknown): value is ToolEventEnvelope {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { kind?: unknown; requestId?: unknown; event?: unknown };
  return (
    record.kind === "tool.event" &&
    typeof record.requestId === "string" &&
    record.requestId.length > 0 &&
    typeof record.event === "object" &&
    record.event !== null
  );
}

export function safeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as { requestId?: unknown; executionId?: unknown };
  if (typeof record.requestId === "string") {
    return record.requestId;
  }
  if (typeof record.executionId === "string") {
    return record.executionId;
  }
  return undefined;
}
