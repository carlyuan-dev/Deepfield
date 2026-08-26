import type { CreateProjectInput, Project } from "./projects.js";
import type { AgentWorkerEvent } from "./chat.js";

export interface DesktopApi {
  projects: {
    create(input: CreateProjectInput): Promise<Project>;
    list(): Promise<Project[]>;
  };
  settings: {
    hasDeepSeekKey(): Promise<boolean>;
    setDeepSeekKey(value: string): Promise<void>;
  };
  chat: {
    send(projectId: string, content: string): Promise<{ requestId: string }>;
    subscribe(listener: (event: AgentWorkerEvent) => void): () => void;
  };
}
