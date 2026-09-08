import { Value } from "typebox/value";
import {
  ChatRequestOptionsSchema,
  CreateProjectInputSchema,
  type AgentWorkerEvent,
  type ChatMessage,
  type ChatRequestOptions,
  type ChatSendResult,
  type Conversation,
  type CreateProjectInput,
  type Project,
  type SkillSummary,
  type LlmConnectionStatus,
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

export interface ConversationServiceLike {
  create(): Conversation;
  openInitial(): { active: Conversation; recent: Conversation[] };
  listRecent(): Conversation[];
}

export interface SecretSettingsLike {
  has(name: string): boolean;
  set(name: string, value: string): void;
}

export interface LlmServiceLike {
  checkConnection(): Promise<LlmConnectionStatus>;
}

export interface SkillListLike {
  list(): SkillSummary[];
}

export interface ChatServiceLike {
  send(
    conversationId: string,
    content: string,
    requestId: string,
    onEvent: (event: AgentWorkerEvent) => void,
    options: ChatRequestOptions,
  ): Promise<ChatSendResult>;
  listMessages(conversationId: string): ChatMessage[];
}

export interface IpcServiceDeps {
  ipcMain: IpcMainLike;
  conversations: ConversationServiceLike;
  projects: ProjectServiceLike;
  settings: SecretSettingsLike;
  llm: LlmServiceLike;
  skills: SkillListLike;
  chat: ChatServiceLike;
}

const INVOKE_CHANNELS = [
  IPC_CHANNELS.projectsCreate,
  IPC_CHANNELS.projectsList,
  IPC_CHANNELS.conversationsCreate,
  IPC_CHANNELS.conversationsOpenInitial,
  IPC_CHANNELS.conversationsListRecent,
  IPC_CHANNELS.settingsHasDeepSeekKey,
  IPC_CHANNELS.settingsSetDeepSeekKey,
  IPC_CHANNELS.llmCheckConnection,
  IPC_CHANNELS.skillsList,
  IPC_CHANNELS.chatSend,
  IPC_CHANNELS.chatListMessages,
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

  deps.ipcMain.handle(IPC_CHANNELS.conversationsCreate, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid conversation input");
    }
    return deps.conversations.create();
  });

  deps.ipcMain.handle(IPC_CHANNELS.conversationsOpenInitial, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid conversation input");
    }
    return deps.conversations.openInitial();
  });

  deps.ipcMain.handle(IPC_CHANNELS.conversationsListRecent, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid conversation input");
    }
    return deps.conversations.listRecent();
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

  deps.ipcMain.handle(IPC_CHANNELS.llmCheckConnection, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid llm input");
    }
    return deps.llm.checkConnection();
  });

  deps.ipcMain.handle(IPC_CHANNELS.skillsList, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid list input");
    }
    // The Main catalog exposes only summary metadata; full skill content stays
    // in the backend (Main and Utility) boundary.
    return deps.skills.list();
  });

  deps.ipcMain.handle(IPC_CHANNELS.chatSend, async (event, ...args) => {
    const conversationId = args[0];
    const content = args[1];
    const requestId = args[2];
    const options = args[3];
    if (
      args.length !== 4 ||
      typeof conversationId !== "string" ||
      conversationId.length === 0 ||
      typeof content !== "string" ||
      content.trim().length === 0 ||
      typeof requestId !== "string" ||
      requestId.length === 0 ||
      options === undefined ||
      !Value.Check(ChatRequestOptionsSchema, options)
    ) {
      throw new Error("invalid chat input");
    }
    trackSender(event.sender);
    return deps.chat.send(conversationId, content, requestId, (workerEvent) => {
      emitToSender(event.sender, workerEvent);
    }, options);
  });

  deps.ipcMain.handle(IPC_CHANNELS.chatListMessages, async (_event, ...args) => {
    const conversationId = args[0];
    if (args.length !== 1 || typeof conversationId !== "string" || conversationId.length === 0) {
      throw new Error("invalid chat input");
    }
    return deps.chat.listMessages(conversationId);
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
