import type { AgentWorkerEvent, ToolExecutionEvent } from "@deepfield/contracts";

export const MAX_PENDING_CHAT_EVENTS = 1000;
export const MAX_PENDING_TOOL_EVENTS = 1000;

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

export type StreamEvent = AgentWorkerEvent | ToolExecutionEvent;

export interface PendingStream {
  kind: "chat" | "tool";
  id: string;
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
