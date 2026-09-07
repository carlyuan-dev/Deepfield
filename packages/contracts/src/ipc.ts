import type { CreateProjectInput, Project } from "./projects.js";
import type { Conversation } from "./conversations.js";
import type { AgentWorkerEvent, ChatMessage, ChatRequestOptions, ChatSendResult } from "./chat.js";
import type { SkillSummary } from "./skills.js";

export interface DesktopApi {
  conversations: {
    create(): Promise<Conversation>;
    openInitial(): Promise<{ active: Conversation; recent: Conversation[] }>;
    listRecent(): Promise<Conversation[]>;
  };
  projects: {
    create(input: CreateProjectInput): Promise<Project>;
    list(): Promise<Project[]>;
  };
  settings: {
    hasDeepSeekKey(): Promise<boolean>;
    setDeepSeekKey(value: string): Promise<void>;
  };
  skills: {
    list(): Promise<SkillSummary[]>;
  };
  chat: {
    send(
      conversationId: string,
      content: string,
      requestId: string,
      options: ChatRequestOptions,
    ): Promise<ChatSendResult>;
    subscribe(listener: (event: AgentWorkerEvent) => void): () => void;
    listMessages(conversationId: string): Promise<ChatMessage[]>;
  };
}
