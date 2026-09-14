import type { AgentWorkerEvent } from "@deepfield/contracts";

export interface ChatEventPayload {
  conversationId: string;
  event: AgentWorkerEvent;
}

export type ChatListener = (payload: ChatEventPayload) => void;

export interface ChatEventHub {
  registerRequest(requestId: string, conversationId: string): void;
  unregisterRequest(requestId: string): void;
  emit(event: AgentWorkerEvent): void;
  subscribe(listener: ChatListener): () => void;
  activeCount(): number;
  isConversationActive(conversationId: string): boolean;
  dispose(): void;
}

const MAX_REMEMBERED = 100;

function isTerminal(event: AgentWorkerEvent): boolean {
  return event.type === "completed" || event.type === "failed";
}

export function createChatEventHub(): ChatEventHub {
  const listeners = new Set<ChatListener>();
  const requestConversations = new Map<string, string>();
  const rememberedTerminals = new Set<string>();

  return {
    registerRequest(requestId, conversationId) {
      requestConversations.set(requestId, conversationId);
      rememberedTerminals.delete(requestId);
    },
    unregisterRequest(requestId) {
      requestConversations.delete(requestId);
    },
    emit(event) {
      const conversationId = requestConversations.get(event.requestId);
      if (conversationId === undefined) {
        return; // never guess an unknown request's conversation
      }
      if (rememberedTerminals.has(event.requestId)) {
        return; // late event after a terminal — drop
      }
      if (isTerminal(event)) {
        for (const listener of [...listeners]) {
          listener({ conversationId, event });
        }
        requestConversations.delete(event.requestId);
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
        listener({ conversationId, event });
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activeCount() {
      return requestConversations.size;
    },
    isConversationActive(conversationId) {
      return [...requestConversations.values()].some((value) => value === conversationId);
    },
    dispose() {
      listeners.clear();
      requestConversations.clear();
      rememberedTerminals.clear();
    },
  };
}
