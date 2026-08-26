import type { AgentWorkerEvent } from "@deepfield/contracts";

export interface ChatEventPayload {
  projectId: string | undefined;
  event: AgentWorkerEvent;
}

export type ChatListener = (payload: ChatEventPayload) => void;

const listeners = new Set<ChatListener>();
const requestProjects = new Map<string, string>();
let currentProjectId: string | undefined;

export function registerChatListener(listener: ChatListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setCurrentChatProject(projectId: string | undefined): void {
  currentProjectId = projectId;
}

export function registerRequestProject(requestId: string, projectId: string): void {
  requestProjects.set(requestId, projectId);
}

export function emitChatEvent(event: AgentWorkerEvent): void {
  const projectId = requestProjects.get(event.requestId) ?? currentProjectId;
  for (const listener of [...listeners]) {
    listener({ projectId, event });
  }
}
