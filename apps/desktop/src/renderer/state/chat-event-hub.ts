import type { AgentWorkerEvent } from "@deepfield/contracts";

export interface ChatEventPayload {
  projectId: string;
  event: AgentWorkerEvent;
}

export type ChatListener = (payload: ChatEventPayload) => void;

export interface ChatEventHub {
  registerRequest(requestId: string, projectId: string): void;
  unregisterRequest(requestId: string): void;
  emit(event: AgentWorkerEvent): void;
  subscribe(listener: ChatListener): () => void;
  activeCount(): number;
  dispose(): void;
}

const MAX_REMEMBERED = 100;

function isTerminal(event: AgentWorkerEvent): boolean {
  return event.type === "completed" || event.type === "failed";
}

export function createChatEventHub(): ChatEventHub {
  const listeners = new Set<ChatListener>();
  const requestProjects = new Map<string, string>();
  const rememberedTerminals = new Set<string>();

  return {
    registerRequest(requestId, projectId) {
      requestProjects.set(requestId, projectId);
      rememberedTerminals.delete(requestId);
    },
    unregisterRequest(requestId) {
      requestProjects.delete(requestId);
    },
    emit(event) {
      const projectId = requestProjects.get(event.requestId);
      if (projectId === undefined) {
        return; // never guess an unknown request's project
      }
      if (rememberedTerminals.has(event.requestId)) {
        return; // late event after a terminal — drop
      }
      if (isTerminal(event)) {
        for (const listener of [...listeners]) {
          listener({ projectId, event });
        }
        requestProjects.delete(event.requestId);
        if (rememberedTerminals.size >= MAX_REMEMBERED) {
          const oldest = rememberedTerminals.values().next().value;
          if (oldest !== undefined) {
            rememberedTerminals.delete(oldest);
          }
        }
        rememberedTerminals.add(event.requestId);
        return;
      }
      for (const listener of [...listeners]) {
        listener({ projectId, event });
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activeCount() {
      return requestProjects.size;
    },
    dispose() {
      listeners.clear();
      requestProjects.clear();
      rememberedTerminals.clear();
    },
  };
}
