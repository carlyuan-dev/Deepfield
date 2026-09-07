import { Value } from "typebox/value";
import {
  AgentWorkerEventSchema,
  type AgentWorkerEvent,
  type ChatMessage,
  type ChatRequestOptions,
  type CreateProjectInput,
  type DesktopApi,
  type Project,
  type SkillSummary,
} from "@deepfield/contracts";

export const IPC_CHANNELS = {
  projectsCreate: "deepfield:projects:create",
  projectsList: "deepfield:projects:list",
  settingsHasDeepSeekKey: "deepfield:settings:hasDeepSeekKey",
  settingsSetDeepSeekKey: "deepfield:settings:setDeepSeekKey",
  skillsList: "deepfield:skills:list",
  chatSend: "deepfield:chat:send",
  chatEvents: "deepfield:chat:events",
  chatListMessages: "deepfield:chat:listMessages",
} as const;

export interface IpcBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): () => void;
}

export function createPreloadApi(ipc: IpcBridge): DesktopApi {
  return {
    projects: {
      create: (input: CreateProjectInput) =>
        ipc.invoke(IPC_CHANNELS.projectsCreate, input) as Promise<Project>,
      list: () => ipc.invoke(IPC_CHANNELS.projectsList) as Promise<Project[]>,
    },
    settings: {
      hasDeepSeekKey: () =>
        ipc.invoke(IPC_CHANNELS.settingsHasDeepSeekKey) as Promise<boolean>,
      setDeepSeekKey: (value: string) =>
        ipc.invoke(IPC_CHANNELS.settingsSetDeepSeekKey, value) as Promise<void>,
    },
    skills: {
      list: () => ipc.invoke(IPC_CHANNELS.skillsList) as Promise<SkillSummary[]>,
    },
    chat: {
      send: (
        projectId: string,
        content: string,
        requestId: string,
        options: ChatRequestOptions,
      ) =>
        ipc.invoke(IPC_CHANNELS.chatSend, projectId, content, requestId, options) as Promise<{
          requestId: string;
        }>,
      subscribe: (listener: (event: AgentWorkerEvent) => void) =>
        ipc.on(IPC_CHANNELS.chatEvents, (_event, value) => {
          if (Value.Check(AgentWorkerEventSchema, value)) {
            listener(value);
          }
        }),
      listMessages: (projectId: string) =>
        ipc.invoke(IPC_CHANNELS.chatListMessages, projectId) as Promise<ChatMessage[]>,
    },
  };
}
