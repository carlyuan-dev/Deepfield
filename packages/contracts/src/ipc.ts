import type { CreateProjectInput, Project } from "./projects.js";
import type { AgentWorkerEvent, ChatMessage, ChatRequestOptions } from "./chat.js";
import type { SkillSummary } from "./skills.js";

export interface DesktopApi {
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
      projectId: string,
      content: string,
      requestId: string,
      options: ChatRequestOptions,
    ): Promise<{ requestId: string }>;
    subscribe(listener: (event: AgentWorkerEvent) => void): () => void;
    listMessages(projectId: string): Promise<ChatMessage[]>;
  };
}
