/** Transport-safe collaboration contracts. Runtime ports live in ./runtime. */
export type AgentJson = null | boolean | number | string | AgentJson[] | { [key: string]: AgentJson };
export type AgentRunStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export type AgentMessageStatus = 'queued' | 'delivered' | 'undelivered';
export interface AgentOwner { kind: 'chat' | 'capability'; id: string; }
export interface AgentTaskInput { text: string; context?: AgentJson; }
export interface AgentTaskSpec extends AgentTaskInput { title: string; /** Host-admitted execution configuration identifier; never credentials. */ configurationId: string; }
export interface AgentTaskMessage { messageId: string; commandId: string; text: string; status: AgentMessageStatus; createdAt: number; deliveredAt?: number; }
export interface AgentResultReference { scopeId: string; taskId: string; runId: string; }
export interface AgentRunResult { summary: string; text: string; sources?: AgentJson[]; limitations?: string[]; }
export interface AgentRunView {
  runId: string; taskId: string; sequence: number; commandId: string; input: AgentTaskInput;
  status: AgentRunStatus; createdAt: number; startedAt?: number; endedAt?: number;
  errorCode?: string; result?: AgentRunResult; transcript?: AgentJson; messages: AgentTaskMessage[];
}
export interface AgentTaskView { taskId: string; spec: AgentTaskSpec; runs: AgentRunView[]; }
export interface AgentCollaborationEvent {
  scopeId: string; taskId: string; runId: string; cursor: number; timestamp: number;
  type: 'status' | 'message' | 'progress'; status?: AgentRunStatus; messageId?: string;
  messageStatus?: AgentMessageStatus; summary?: string;
}
export interface AgentCommandReceipt { taskId: string; runId: string; messageId?: string; status: AgentRunStatus | AgentMessageStatus; }
export interface AgentCommandRecord { commandId: string; fingerprint: string; receipt: AgentCommandReceipt; }
export interface AgentCoordinatorLimits {
  concurrency: number; maxTasks: number; maxRuns: number; maxRunsPerTask: number;
  maxAgentTurns: number; deadline: number; maxMessageChars: number;
  maxQueuedMessages: number; maxResultChars: number; cancellationGraceMs: number;
}
export interface AgentCoordinatorSnapshot {
  version: 1; scopeId: string; owner: AgentOwner; limits: AgentCoordinatorLimits;
  closed: boolean; taskCount: number; runCount: number; cursor: number;
  tasks: AgentTaskView[]; commands: AgentCommandRecord[]; events: AgentCollaborationEvent[];
}
export interface AgentWaitResult { cursor: number; events: AgentCollaborationEvent[]; runs: AgentRunView[]; timedOut: boolean; }
export interface AgentCoordinator {
  readonly scopeId: string;
  spawn(spec: AgentTaskSpec, commandId: string): Promise<AgentCommandReceipt>;
  followUp(taskId: string, input: AgentTaskInput, commandId: string): Promise<AgentCommandReceipt>;
  send(taskId: string, text: string, commandId: string): Promise<AgentCommandReceipt>;
  get(taskId: string): AgentTaskView;
  list(): AgentTaskView[];
  readResult(reference: AgentResultReference, options?: { offset?: number; limit?: number }): AgentRunResult;
  wait(runIds: string[], cursor: number, timeoutMs: number, signal?: AbortSignal): Promise<AgentWaitResult>;
  cancel(taskId: string): Promise<void>;
  close(): Promise<void>;
  snapshot(): AgentCoordinatorSnapshot;
  subscribe(listener: (event: AgentCollaborationEvent) => void): () => void;
}
export { parseAgentCoordinatorSnapshot } from './validation.js';
