import { registerCapabilityIpc } from "./capabilities/ipc.js";
import type { CapabilityRegistry } from "./capabilities/registry.js";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { UsageDashboardArgsSchema, UsageDeleteUnknownFailuresArgsSchema } from "@deepfield/contracts";
import type { UsageDashboardApi } from "@deepfield/base/usage";
import { AppError, appResult, ChatRequestOptionsSchema, CopyTextArgsSchema, ConversationDeleteArgsSchema, SettingsGetArgsSchema, SettingsLlmDraftArgsSchema, SettingsSearchDraftArgsSchema, SettingsProfileIdArgsSchema, SettingsDeleteProfileArgsSchema, type AgentWorkerEvent, type ChatMessage, type ChatRequestOptions, type ChatSendResult, type Conversation, type SkillSummary, type LlmProfileDraft, type SearchProfileDraft, type SettingsView, type DiagnosticResult,  } from "@deepfield/contracts";
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

export interface ConversationServiceLike {
  setWebSearchEnabled(conversationId: string, enabled: boolean): Conversation;
  create(): Conversation;
  delete(conversationId: string): void;
  openInitial(): { active: Conversation; recent: Conversation[] };
  listRecent(): Conversation[];
}

export interface ConfigurationServiceLike {
  get(): Promise<SettingsView>;
  saveLlmProfile(input: LlmProfileDraft): Promise<SettingsView>;
  activateLlmProfile(id: string | null): Promise<SettingsView>;
  deleteLlmProfile(id: string): Promise<SettingsView>;
  diagnoseLlm(input: LlmProfileDraft): Promise<DiagnosticResult>;
  saveSearchProfile(input: SearchProfileDraft): Promise<SettingsView>;
  activateSearchProfile(id: string | null): Promise<SettingsView>;
  deleteSearchProfile(id: string): Promise<SettingsView>;
  diagnoseSearch(input: SearchProfileDraft): Promise<DiagnosticResult>;
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
  subscribeConversationUpdates(listener: (conversation: Conversation) => void): () => void;
}

export interface ClipboardWriterLike {
  writeText(text: string): void | Promise<void>;
}

export interface IpcServiceDeps {
  usage?: UsageDashboardApi;
  capabilities?: CapabilityRegistry;
  onConfigurationChanged?: () => void;
  ipcMain: IpcMainLike;
  conversations: ConversationServiceLike;
  settings: ConfigurationServiceLike;
  skills: SkillListLike;
  chat: ChatServiceLike;
  clipboard: ClipboardWriterLike;
}

const INVOKE_CHANNELS = [
  IPC_CHANNELS.usageGetDashboard,
  IPC_CHANNELS.usageDeleteUnknownFailures,
  IPC_CHANNELS.usageRepair,
  IPC_CHANNELS.usageAcknowledgeUnknown,
  IPC_CHANNELS.usageAcknowledgeHistory,
  IPC_CHANNELS.copyText,
  IPC_CHANNELS.conversationsCreate,
  IPC_CHANNELS.conversationsSetWebSearchEnabled,
  IPC_CHANNELS.conversationsDelete,
  IPC_CHANNELS.conversationsOpenInitial,
  IPC_CHANNELS.conversationsListRecent,
  IPC_CHANNELS.settingsGet,
  IPC_CHANNELS.settingsSaveLlmProfile,
  IPC_CHANNELS.settingsActivateLlmProfile,
  IPC_CHANNELS.settingsDeleteLlmProfile,
  IPC_CHANNELS.settingsDiagnoseLlm,
  IPC_CHANNELS.settingsSaveSearchProfile,
  IPC_CHANNELS.settingsActivateSearchProfile,
  IPC_CHANNELS.settingsDeleteSearchProfile,
  IPC_CHANNELS.settingsDiagnoseSearch,
  IPC_CHANNELS.skillsList,
  IPC_CHANNELS.chatSend,
  IPC_CHANNELS.chatListMessages,
] as const;

export function registerIpcHandlers(deps: IpcServiceDeps): () => void {
  const disposeCapabilities = deps.capabilities ? registerCapabilityIpc(deps.ipcMain, deps.capabilities) : undefined;
  deps.ipcMain.handle(IPC_CHANNELS.usageGetDashboard, async (_event, ...args) => appResult(async () => {
    if (!Value.Check(UsageDashboardArgsSchema, args)) throw new AppError("INPUT.INVALID");
    try { new Intl.DateTimeFormat("en", { timeZone: args[0].timeZone }).format(); } catch { throw new AppError("INPUT.INVALID"); }
    if (!deps.usage) throw new AppError("INTERNAL.UNKNOWN");
    return deps.usage.getDashboard(args[0]);
  }));
  deps.ipcMain.handle(IPC_CHANNELS.usageDeleteUnknownFailures, async (_event, ...args) => appResult(async () => {
    if (!Value.Check(UsageDeleteUnknownFailuresArgsSchema, args)) throw new AppError("INPUT.INVALID");
    if (!deps.usage) throw new AppError("INTERNAL.UNKNOWN");
    return deps.usage.deleteUnknownFailures(args[0]);
  }));
  deps.ipcMain.handle(IPC_CHANNELS.usageRepair, async (_event, ...args) => appResult(async () => {
    if (args.length !== 0) throw new AppError("INPUT.INVALID");
    if (!deps.usage) throw new AppError("INTERNAL.UNKNOWN");
    return deps.usage.repair();
  }));
  deps.ipcMain.handle(IPC_CHANNELS.usageAcknowledgeUnknown, async (_event, ...args) => appResult(async () => {
    const value = args[0];
    if (args.length !== 1 || !Array.isArray(value) || value.length > 1000 || value.some((id) => typeof id !== "string" || id.length > 300 || !/^[A-Za-z0-9][A-Za-z0-9_.:/@+~-]*$/.test(id))) throw new AppError("INPUT.INVALID");
    if (!deps.usage) throw new AppError("INTERNAL.UNKNOWN");
    return deps.usage.acknowledgeUnknownUsage(value as string[]);
  }));
  deps.ipcMain.handle(IPC_CHANNELS.usageAcknowledgeHistory, async (_event, ...args) => appResult(async () => {
    if (args.length !== 1 || typeof args[0] !== "string" || !/^\d+:\d+$/.test(args[0])) throw new AppError("INPUT.INVALID");
    if (!deps.usage) throw new AppError("INTERNAL.UNKNOWN");
    return deps.usage.acknowledgeHistoricalIssues(args[0]);
  }));
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

  const unsubscribeConversationUpdates = deps.chat.subscribeConversationUpdates((conversation) => {
    for (const sender of senders.values()) {
      sender.send(IPC_CHANNELS.conversationUpdates, conversation);
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.copyText, async (_event, ...args) => {
    if (!Value.Check(CopyTextArgsSchema, args)) {
      throw new Error("invalid clipboard input");
    }
    await deps.clipboard.writeText(args[0]);
  });

  deps.ipcMain.handle(IPC_CHANNELS.conversationsCreate, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid conversation input");
    }
    return deps.conversations.create();
  });

  deps.ipcMain.handle(IPC_CHANNELS.conversationsSetWebSearchEnabled, async (_event, ...args) => {
    if (args.length !== 2 || !Value.Check(ConversationDeleteArgsSchema, [args[0]]) || typeof args[1] !== "boolean") {
      throw new Error("invalid conversation input");
    }
    return deps.conversations.setWebSearchEnabled(args[0] as string, args[1]);
  });

  deps.ipcMain.handle(IPC_CHANNELS.conversationsDelete, async (_event, ...args) => {
    if (!Value.Check(ConversationDeleteArgsSchema, args)) {
      throw new Error("invalid conversation input");
    }
    deps.conversations.delete(args[0]);
  });

  deps.ipcMain.handle(IPC_CHANNELS.conversationsOpenInitial, async (event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid conversation input");
    }
    trackSender(event.sender);
    return deps.conversations.openInitial();
  });

  deps.ipcMain.handle(IPC_CHANNELS.conversationsListRecent, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid conversation input");
    }
    return deps.conversations.listRecent();
  });

  const diagnosticHandler = <T>(channel: string, schema: TSchema, call: (...args: any[]) => Promise<T>): void => {
    deps.ipcMain.handle(channel, async (_event, ...args) => appResult(async () => {
      if (!Value.Check(schema, args)) throw new AppError("INPUT.INVALID");
      return call(...args);
    }));
  };
  const settingsHandler = <T>(channel: string, schema: TSchema, call: (...args: any[]) => Promise<T>): void => {
    deps.ipcMain.handle(channel, async (_event, ...args) => {
      if (!Value.Check(schema, args)) throw new Error("invalid settings input");
      try {
        const result = await call(...args);
        if (channel !== IPC_CHANNELS.settingsGet) deps.onConfigurationChanged?.();
        return result;
      }
      catch { throw new Error("settings operation failed"); }
    });
  };
  settingsHandler(IPC_CHANNELS.settingsGet, SettingsGetArgsSchema, () => deps.settings.get());
  settingsHandler(IPC_CHANNELS.settingsSaveLlmProfile, SettingsLlmDraftArgsSchema, (input: LlmProfileDraft) => deps.settings.saveLlmProfile(input));
  settingsHandler(IPC_CHANNELS.settingsActivateLlmProfile, SettingsProfileIdArgsSchema, (id: string | null) => deps.settings.activateLlmProfile(id));
  settingsHandler(IPC_CHANNELS.settingsDeleteLlmProfile, SettingsDeleteProfileArgsSchema, (id: string) => deps.settings.deleteLlmProfile(id));
  diagnosticHandler(IPC_CHANNELS.settingsDiagnoseLlm, SettingsLlmDraftArgsSchema, (input: LlmProfileDraft) => deps.settings.diagnoseLlm(input));
  settingsHandler(IPC_CHANNELS.settingsSaveSearchProfile, SettingsSearchDraftArgsSchema, (input: SearchProfileDraft) => deps.settings.saveSearchProfile(input));
  settingsHandler(IPC_CHANNELS.settingsActivateSearchProfile, SettingsProfileIdArgsSchema, (id: string | null) => deps.settings.activateSearchProfile(id));
  settingsHandler(IPC_CHANNELS.settingsDeleteSearchProfile, SettingsDeleteProfileArgsSchema, (id: string) => deps.settings.deleteSearchProfile(id));
  diagnosticHandler(IPC_CHANNELS.settingsDiagnoseSearch, SettingsSearchDraftArgsSchema, (input: SearchProfileDraft) => deps.settings.diagnoseSearch(input));

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
    disposeCapabilities?.();
    unsubscribeConversationUpdates();
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
