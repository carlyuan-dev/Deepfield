import type { AgentCoordinatorSnapshot, AgentJson } from './index.js';

export class AgentCollaborationError extends Error {
  constructor(readonly code: string) { super(`Agent collaboration: ${code}`); this.name = 'AgentCollaborationError'; }
}
export function check(value: unknown, code: string): asserts value { if (!value) throw new AgentCollaborationError(code); }
export function safeJson(value: unknown, depth = 0): asserts value is AgentJson {
  check(depth <= 100, 'invalid_json');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { check(Number.isFinite(value), 'invalid_json'); return; }
  check(typeof value === 'object', 'invalid_json');
  check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'invalid_json');
  for (const item of Object.values(value)) safeJson(item, depth + 1);
}
export const clone = <T>(value: T): T => structuredClone(value);
export function text(value: unknown, max = 100_000): asserts value is string { check(typeof value === 'string' && value.length > 0 && value.length <= max, 'invalid_text'); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_snapshot');
  check(Object.keys(value).every(key => keys.includes(key)), 'invalid_snapshot');
}
function integer(value: unknown, min = 0) { check(Number.isSafeInteger(value) && (value as number) >= min, 'invalid_snapshot'); }
const statuses = ['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'];
export function parseAgentCoordinatorSnapshot(value: unknown): AgentCoordinatorSnapshot {
  safeJson(value);
  object(value, ['version','scopeId','owner','limits','closed','taskCount','runCount','cursor','tasks','commands','events']);
  check(value.version === 1 && typeof value.closed === 'boolean', 'invalid_snapshot'); text(value.scopeId, 1024);
  object(value.owner, ['kind','id']); check(['chat','capability'].includes(value.owner.kind as string), 'invalid_snapshot'); text(value.owner.id, 1024);
  const limitKeys = ['concurrency','maxTasks','maxRuns','maxRunsPerTask','maxAgentTurns','deadline','maxMessageChars','maxQueuedMessages','maxResultChars','cancellationGraceMs'];
  object(value.limits, limitKeys); for (const key of limitKeys) integer(value.limits[key], key === 'cancellationGraceMs' ? 0 : 1);
  integer(value.taskCount); integer(value.runCount); integer(value.cursor);
  check(Array.isArray(value.tasks) && Array.isArray(value.commands) && Array.isArray(value.events), 'invalid_snapshot');
  const tasks = new Set<string>(); const runs = new Set<string>(); const messages = new Set<string>(); const identities = new Set<string>(); const runOwners = new Map<string,string>(); const messageOwners = new Map<string,string>(); let count = 0;
  for (const task of value.tasks) {
    object(task, ['taskId','spec','runs']); text(task.taskId); check(!identities.has(task.taskId), 'invalid_snapshot'); tasks.add(task.taskId); identities.add(task.taskId);
    object(task.spec, ['title','configurationId','text','context']); text(task.spec.title,1000); text(task.spec.configurationId,1024); text(task.spec.text,value.limits.maxMessageChars as number);
    check(Array.isArray(task.runs) && task.runs.length > 0, 'invalid_snapshot');
    let sequence = 0;
    for (const run of task.runs) {
      object(run, ['runId','taskId','sequence','commandId','input','status','createdAt','startedAt','endedAt','errorCode','result','transcript','messages']);
      text(run.runId); text(run.commandId); check(!identities.has(run.runId) && run.taskId === task.taskId && run.sequence === ++sequence && statuses.includes(run.status as string), 'invalid_snapshot'); runs.add(run.runId); identities.add(run.runId); runOwners.set(run.runId,task.taskId); count++;
      integer(run.createdAt); if (run.startedAt !== undefined) integer(run.startedAt); if (run.endedAt !== undefined) integer(run.endedAt);
      if (run.errorCode !== undefined) text(run.errorCode, 200);
      object(run.input, ['text','context']); text(run.input.text,value.limits.maxMessageChars as number);
      if (run.result !== undefined) {
        object(run.result, ['summary','text','sources','limitations']); text(run.result.summary,value.limits.maxResultChars as number); text(run.result.text, value.limits.maxResultChars as number);
        if (run.result.sources !== undefined) check(Array.isArray(run.result.sources), 'invalid_snapshot');
        if (run.result.limitations !== undefined) check(Array.isArray(run.result.limitations) && run.result.limitations.every(item => typeof item === 'string'), 'invalid_snapshot');
      }
      check(run.status !== 'completed' || run.result !== undefined, 'invalid_snapshot');
      check(Array.isArray(run.messages), 'invalid_snapshot');
      for (const message of run.messages) {
        object(message, ['messageId','commandId','text','status','createdAt','deliveredAt']); text(message.messageId); text(message.commandId); text(message.text, value.limits.maxMessageChars as number);
        check(!identities.has(message.messageId) && ['queued','delivered','undelivered'].includes(message.status as string), 'invalid_snapshot'); messages.add(message.messageId); identities.add(message.messageId); messageOwners.set(message.messageId,run.runId); integer(message.createdAt); if (message.deliveredAt !== undefined) integer(message.deliveredAt);
      }
    }
    check(task.runs.length <= (value.limits.maxRunsPerTask as number), 'invalid_snapshot');
  }
  check(value.taskCount === tasks.size && value.runCount === count && count <= (value.limits.maxRuns as number) && tasks.size <= (value.limits.maxTasks as number), 'invalid_snapshot');
  const commands = new Set<string>();
  for (const command of value.commands) {
    object(command, ['commandId','fingerprint','receipt']); text(command.commandId); text(command.fingerprint, 1_000_000); check(!commands.has(command.commandId), 'invalid_snapshot'); commands.add(command.commandId);
    object(command.receipt, ['taskId','runId','messageId','status']); check(tasks.has(command.receipt.taskId as string) && runOwners.get(command.receipt.runId as string) === command.receipt.taskId && [...statuses,'delivered','undelivered'].includes(command.receipt.status as string), 'invalid_snapshot');
    if (command.receipt.messageId !== undefined) check(messageOwners.get(command.receipt.messageId as string) === command.receipt.runId, 'invalid_snapshot');
  }
  let cursor = 0;
  for (const event of value.events) {
    object(event, ['scopeId','taskId','runId','cursor','timestamp','type','status','messageId','messageStatus','summary']);
    check(event.scopeId === value.scopeId && tasks.has(event.taskId as string) && runOwners.get(event.runId as string) === event.taskId && event.cursor === ++cursor && ['status','message','progress'].includes(event.type as string), 'invalid_snapshot'); integer(event.timestamp);
    if (event.status !== undefined) check(statuses.includes(event.status as string), 'invalid_snapshot');
    if (event.messageId !== undefined) check(messageOwners.get(event.messageId as string) === event.runId, 'invalid_snapshot');
    if (event.messageStatus !== undefined) check(['queued','delivered','undelivered'].includes(event.messageStatus as string), 'invalid_snapshot');
    if (event.summary !== undefined) text(event.summary, 4000);
  }
  check(cursor === value.cursor, 'invalid_snapshot');
  return clone(value) as unknown as AgentCoordinatorSnapshot;
}
