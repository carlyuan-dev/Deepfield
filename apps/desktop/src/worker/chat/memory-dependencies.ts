import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { MEMORY_TOOL_NAMES, memoryReferences, memoryReferenceKey, type MemoryReference, type MemoryToolReply } from '@deepfield/contracts';
import type { HostClient } from '../host-client.js';

export const OMITTED_MEMORY_MATERIAL = '关联记忆已停用、更新或无法验证，依赖它的材料已省略。请仅使用当前有效材料；需要时向用户说明缺口。';
export type MemoryDependent = { memoryDependencies?: MemoryReference[] };
export function mergeMemoryDependencies(...groups: readonly MemoryReference[][]): MemoryReference[] {
  const refs = [...new Map(groups.flat().map(ref => [memoryReferenceKey(ref), { id: ref.id, revision: ref.revision }])).values()];
  if (refs.length > 100) throw new Error('memory_dependency_limit');
  return refs;
}
export function messageMemoryDependencies(message: AgentMessage, includeReceipts = false): MemoryReference[] {
  const refs = memoryReferences((message as AgentMessage & MemoryDependent).memoryDependencies);
  if (message.role !== 'toolResult') return refs;
  for (const part of message.content) if (part.type === 'text') {
    try {
      const value = JSON.parse(part.text);
      refs.push(...memoryReferences(value?.memoryDependencies));
      if (includeReceipts && MEMORY_TOOL_NAMES.has(message.toolName)) refs.push(...memoryReferences(value?.memoryRefs));
    } catch { /* Non-JSON output contains no structured dependency receipt. */ }
  }
  return mergeMemoryDependencies(refs);
}
export function tagMemoryDependencies<T extends AgentMessage>(message: T, refs: MemoryReference[]): T {
  const dependencies = mergeMemoryDependencies(memoryReferences((message as T & MemoryDependent).memoryDependencies), refs);
  Object.assign(message, { memoryDependencies: dependencies });
  return message;
}
export async function validMemoryDependencies(host: Pick<HostClient,'request'>, requestId: string, refs: MemoryReference[]): Promise<Set<string>> {
  if (!refs.length) return new Set();
  try {
    const reply = await host.request('memory.call', { chatRequestId: requestId, toolCallId: 'collaboration-memory-dependencies', command: { operation: 'validate', refs } }) as { result: MemoryToolReply };
    return new Set(reply.result.status === 'ok' && reply.result.useEnabled ? memoryReferences(reply.result.validRefs).map(memoryReferenceKey) : []);
  } catch { return new Set(); }
}
/** Retain protocol identities while replacing whole derived materials whose dependencies expired. */
export function projectMemoryDependencies(messages: AgentMessage[], valid: ReadonlySet<string>): AgentMessage[] {
  return messages.map(message => {
    const refs = messageMemoryDependencies(message);
    if (!refs.length || refs.every(ref => valid.has(memoryReferenceKey(ref)))) return message;
    if (message.role === 'assistant') return { ...message, memoryDependencies: [], content: [
      { type: 'text' as const, text: OMITTED_MEMORY_MATERIAL },
      ...message.content.flatMap(part => part.type === 'toolCall' ? [{ ...part, arguments: {} }] : []),
    ] };
    if (message.role === 'toolResult') return { ...message, memoryDependencies: [], content: [{ type: 'text' as const, text: OMITTED_MEMORY_MATERIAL }] };
    if (message.role === 'compactionSummary') return { ...message, memoryDependencies: [], summary: OMITTED_MEMORY_MATERIAL };
    if (message.role === 'user') return { ...message, memoryDependencies: [], content: OMITTED_MEMORY_MATERIAL };
    return message;
  });
}
export function createMemoryDependencyTransform(requestId: string, host: Pick<HostClient,'request'>) {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    const refs = mergeMemoryDependencies(...messages.map(message => messageMemoryDependencies(message)));
    return projectMemoryDependencies(messages, await validMemoryDependencies(host, requestId, refs));
  };
}

const collaborationTools = new Set(['spawn_agent','send_agent_message','followup_agent','wait_agents','list_agents','read_agent_result','cancel_agent']);
export function hasUntrackedCollaboration(messages: AgentMessage[]): boolean {
  return messages.some(message => message.role === 'toolResult' && collaborationTools.has(message.toolName) && !Array.isArray((message as AgentMessage & MemoryDependent).memoryDependencies));
}
/** Older collaboration turns cannot prove which Memory revisions their copied prose depended on. */
export function markUntrackedCollaboration(messages: AgentMessage[]): AgentMessage[] {
  if (!hasUntrackedCollaboration(messages)) return messages;
  return messages.map(message => {
    if (Array.isArray((message as AgentMessage & MemoryDependent).memoryDependencies)) return message;
    if (message.role === 'assistant' || message.role === 'toolResult' || (message.role === 'user' && typeof message.content === 'string' && /^\[宿主(?:协作结果|已提交)/u.test(message.content))) {
      return tagMemoryDependencies({ ...message }, [{ id: 'legacy.untracked-memory', revision: 1 }]);
    }
    return message;
  });
}
