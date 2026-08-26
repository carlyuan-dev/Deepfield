import { Value } from "typebox/value";
import {
  CreateProjectInputSchema,
  type AgentWorkerEvent,
  type CreateProjectInput,
  type Project,
} from "@deepfield/contracts";
import { DEEPSEEK_KEY_NAME } from "@deepfield/application";
import { IPC_CHANNELS } from "../preload/preload-api.js";

export interface IpcEventLike {
  sender: WebContentsLike;
}

export interface WebContentsLike {
  id: number;
  send(channel: string, payload: unknown): void;
  on(event: "destroyed", listener: () => void): void;
  removeListener(event: "destroyed", listener: () => void): void;
}

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcEventLike, ...args: unknown[]) => unknown | Promise<unknown>,
  ): void;
  removeHandler(channel: string): void;
}

export interface ProjectServiceLike {
  create(input: CreateProjectInput): Project;
  list(): Project[];
}

export interface SecretSettingsLike {
  has(name: string): boolean;
  set(name: string, value: string): void;
}

export interface ChatServiceLike {
  send(
    projectId: string,
    content: string,
    onEvent: (event: AgentWorkerEvent) => void,
  ): Promise<{ requestId: string }>;
}

export interface IpcServiceDeps {
  ipcMain: IpcMainLike;
  projects: ProjectServiceLike;
  settings: SecretSettingsLike;
  chat: ChatServiceLike;
}

const INVOKE_CHANNELS = [
  IPC_CHANNELS.projectsCreate,
  IPC_CHANNELS.projectsList,
  IPC_CHANNELS.settingsHasDeepSeekKey,
  IPC_CHANNELS.settingsSetDeepSeekKey,
  IPC_CHANNELS.chatSend,
] as const;

export function registerIpcHandlers(deps: IpcServiceDeps): () => void {
  const senders = new Map<number, WebContentsLike>();
  const destroyedListeners = new Map<number, () => void>();

  const trackSender = (sender: WebContentsLike): void => {
    if (senders.has(sender.id)) {
      return;
    }
    senders.set(sender.id, sender);
    const onDestroyed = (): void => {
      senders.delete(sender.id);
      destroyedListeners.delete(sender.id);
      sender.removeListener("destroyed", onDestroyed);
    };
    destroyedListeners.set(sender.id, onDestroyed);
    sender.on("destroyed", onDestroyed);
  };

  const emitToSender = (sender: WebContentsLike, event: AgentWorkerEvent): void => {
    if (senders.get(sender.id) !== sender) {
      return;
    }
    sender.send(IPC_CHANNELS.chatEvents, event);
  };

  deps.ipcMain.handle(IPC_CHANNELS.projectsCreate, async (_event, ...args) => {
    const input = args[0];
    if (
      args.length !== 1 ||
      input === undefined ||
      !Value.Check(CreateProjectInputSchema, input) ||
      input.industry.trim().length === 0
    ) {
      throw new Error("invalid project input");
    }
    return deps.projects.create(input);
  });

  deps.ipcMain.handle(IPC_CHANNELS.projectsList, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid list input");
    }
    return deps.projects.list();
  });

  deps.ipcMain.handle(IPC_CHANNELS.settingsHasDeepSeekKey, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid settings input");
    }
    return deps.settings.has(DEEPSEEK_KEY_NAME);
  });

  deps.ipcMain.handle(IPC_CHANNELS.settingsSetDeepSeekKey, async (_event, ...args) => {
    const value = args[0];
    if (args.length !== 1 || typeof value !== "string" || value.trim().length === 0) {
      throw new Error("invalid settings input");
    }
    deps.settings.set(DEEPSEEK_KEY_NAME, value);
  });

  deps.ipcMain.handle(IPC_CHANNELS.chatSend, async (event, ...args) => {
    const projectId = args[0];
    const content = args[1];
    if (
      args.length !== 2 ||
      typeof projectId !== "string" ||
      projectId.length === 0 ||
      typeof content !== "string" ||
      content.trim().length === 0
    ) {
      throw new Error("invalid chat input");
    }
    trackSender(event.sender);
    return deps.chat.send(projectId, content, (workerEvent) => {
      emitToSender(event.sender, workerEvent);
    });
  });

  return () => {
    for (const channel of INVOKE_CHANNELS) {
      deps.ipcMain.removeHandler(channel);
    }
    for (const [id, onDestroyed] of destroyedListeners) {
      senders.get(id)?.removeListener("destroyed", onDestroyed);
    }
    senders.clear();
    destroyedListeners.clear();
  };
}
