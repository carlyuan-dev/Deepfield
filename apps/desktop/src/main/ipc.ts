import { Value } from "typebox/value";
import {
  ChatRequestOptionsSchema,
  CompanyDraftSchema,
  CreateIndustryResearchItemInputSchema,
  UpdateIndustryResearchItemInputSchema,
  type CapabilityItem,
  type CompanyDraft,
  type ItemCompanyView,
  type UpdateIndustryResearchItemInput,
  type AgentWorkerEvent,
  type ChatMessage,
  type ChatRequestOptions,
  type ChatSendResult,
  type Conversation,
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

export interface IndustryResearchServiceLike {
  createItem(input: unknown): CapabilityItem;
  updateItem(itemId: string, input: UpdateIndustryResearchItemInput): CapabilityItem;
  deleteItem(itemId: string): void;
  deleteItems(itemIds: string[]): void;
  listItems(): CapabilityItem[];
  getItem(itemId: string): CapabilityItem | undefined;
  listCompanies(itemId: string): ItemCompanyView[];
  addCompany(itemId: string, draft: CompanyDraft): ItemCompanyView;
  addCompanies(itemId: string, drafts: CompanyDraft[]): ItemCompanyView[];
  removeCompany(itemId: string, companyId: string): void;
  removeCompanies(itemId: string, companyIds: string[]): void;
  recognizeCompanies(itemId: string, text: string): Promise<CompanyDraft[]>;
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
  industryResearch: IndustryResearchServiceLike;
  settings: SecretSettingsLike;
  llm: LlmServiceLike;
  skills: SkillListLike;
  chat: ChatServiceLike;
}

const INVOKE_CHANNELS = [
  IPC_CHANNELS.industryResearchCreateItem,
  IPC_CHANNELS.industryResearchUpdateItem,
  IPC_CHANNELS.industryResearchDeleteItem,
  IPC_CHANNELS.industryResearchDeleteItems,
  IPC_CHANNELS.industryResearchListItems,
  IPC_CHANNELS.industryResearchGetItem,
  IPC_CHANNELS.industryResearchListCompanies,
  IPC_CHANNELS.industryResearchAddCompany,
  IPC_CHANNELS.industryResearchAddCompanies,
  IPC_CHANNELS.industryResearchRemoveCompany,
  IPC_CHANNELS.industryResearchRemoveCompanies,
  IPC_CHANNELS.industryResearchRecognizeCompanies,
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

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchCreateItem, async (_event, ...args) => {
    const input = args[0];
    if (
      args.length !== 1 ||
      input === undefined ||
      !Value.Check(CreateIndustryResearchItemInputSchema, input) ||
      input.industry.trim().length === 0
    ) {
      throw new Error("invalid research item input");
    }
    return deps.industryResearch.createItem(input);
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchUpdateItem, async (_event, ...args) => {
    const itemId = args[0];
    const input = args[1];
    if (
      args.length !== 2 ||
      typeof itemId !== "string" ||
      itemId.length === 0 ||
      !Value.Check(UpdateIndustryResearchItemInputSchema, input) ||
      input.industry.trim().length === 0
    ) {
      throw new Error("invalid research item input");
    }
    try {
      return deps.industryResearch.updateItem(itemId, input);
    } catch {
      throw new Error("research item update failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchDeleteItem, async (_event, ...args) => {
    const itemId = args[0];
    if (args.length !== 1 || typeof itemId !== "string" || itemId.length === 0) {
      throw new Error("invalid research item input");
    }
    try {
      return deps.industryResearch.deleteItem(itemId);
    } catch {
      throw new Error("research item deletion failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchDeleteItems, async (_event, ...args) => {
    const itemIds = args[0];
    if (
      args.length !== 1 ||
      !Array.isArray(itemIds) ||
      itemIds.length === 0 ||
      !itemIds.every((itemId) => typeof itemId === "string" && itemId.length > 0)
    ) {
      throw new Error("invalid research item input");
    }
    try {
      return deps.industryResearch.deleteItems(itemIds);
    } catch {
      throw new Error("research item deletion failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchListItems, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid research item input");
    }
    return deps.industryResearch.listItems();
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchGetItem, async (_event, ...args) => {
    const itemId = args[0];
    if (args.length !== 1 || typeof itemId !== "string" || itemId.length === 0) {
      throw new Error("invalid research item input");
    }
    return deps.industryResearch.getItem(itemId);
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchListCompanies, async (_event, ...args) => {
    const itemId = args[0];
    if (args.length !== 1 || typeof itemId !== "string" || itemId.length === 0) {
      throw new Error("invalid company input");
    }
    return deps.industryResearch.listCompanies(itemId);
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchAddCompany, async (_event, ...args) => {
    const itemId = args[0];
    const draft = args[1];
    if (
      args.length !== 2 ||
      typeof itemId !== "string" ||
      itemId.length === 0 ||
      !Value.Check(CompanyDraftSchema, draft)
    ) {
      throw new Error("invalid company input");
    }
    return deps.industryResearch.addCompany(itemId, draft);
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchAddCompanies, async (_event, ...args) => {
    const itemId = args[0];
    const drafts = args[1];
    if (
      args.length !== 2 ||
      typeof itemId !== "string" ||
      itemId.length === 0 ||
      !Array.isArray(drafts) ||
      !drafts.every((draft) => Value.Check(CompanyDraftSchema, draft))
    ) {
      throw new Error("invalid company input");
    }
    return deps.industryResearch.addCompanies(itemId, drafts);
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchRemoveCompany, async (_event, ...args) => {
    const itemId = args[0];
    const companyId = args[1];
    if (
      args.length !== 2 ||
      typeof itemId !== "string" ||
      itemId.length === 0 ||
      typeof companyId !== "string" ||
      companyId.length === 0
    ) {
      throw new Error("invalid company input");
    }
    try {
      return deps.industryResearch.removeCompany(itemId, companyId);
    } catch {
      throw new Error("company removal failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchRemoveCompanies, async (_event, ...args) => {
    const itemId = args[0];
    const companyIds = args[1];
    if (
      args.length !== 2 ||
      typeof itemId !== "string" ||
      itemId.length === 0 ||
      !Array.isArray(companyIds) ||
      !companyIds.every((companyId) => typeof companyId === "string" && companyId.length > 0)
    ) {
      throw new Error("invalid company input");
    }
    try {
      return deps.industryResearch.removeCompanies(itemId, companyIds);
    } catch {
      throw new Error("company removal failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchRecognizeCompanies, async (_event, ...args) => {
    const itemId = args[0];
    const text = args[1];
    if (
      args.length !== 2 ||
      typeof itemId !== "string" ||
      itemId.length === 0 ||
      typeof text !== "string" ||
      text.trim().length === 0
    ) {
      throw new Error("invalid company input");
    }
    return deps.industryResearch.recognizeCompanies(itemId, text);
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
