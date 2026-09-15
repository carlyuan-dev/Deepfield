import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  ChatRequestOptionsSchema,
  CopyTextArgsSchema,
  ConversationDeleteArgsSchema,
  CompanyResearchCancelArgsSchema,
  CompanyResearchGetRunArgsSchema,
  CompanyResearchRetryStructuringArgsSchema,
  CompanyResearchStartArgsSchema,
  CompanyResearchSubscribeArgsSchema,
  CompanyResearchTargetArgsSchema,
  CompanyResearchEventSchema,
  SettingsGetArgsSchema,
  SettingsLlmDraftArgsSchema,
  SettingsSearchDraftArgsSchema,
  SettingsProfileIdArgsSchema,
  SettingsDeleteProfileArgsSchema,
  CompanyDraftSchema,
  CompanyProfileInputSchema,
  CompanyProfileEventSchema,
  CreateIndustryResearchItemInputSchema,
  UpdateIndustryResearchItemInputSchema,
  type CapabilityItem,
  type Company,
  type CompanyDraft,
  type CompanyProfileInput,
  type CompanyProfileEvent,
  type CompanyResearchState,
  type CompanyResearchEvent,
  type ItemCompanyView,
  type UpdateIndustryResearchItemInput,
  type AgentWorkerEvent,
  type ChatMessage,
  type ChatRequestOptions,
  type ChatSendResult,
  type Conversation,
  type SkillSummary,
  type LlmProfileDraft,
  type SearchProfileDraft,
  type SettingsView,
  type DiagnosticResult,
  type ResearchRun,
  type ResearchRunSummary,
  type StartCompanyResearchInput,
} from "@deepfield/contracts";
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
  updateCompany(companyId: string, input: CompanyProfileInput): Company;
  addCompany(itemId: string, draft: CompanyDraft): ItemCompanyView;
  addCompanies(itemId: string, drafts: CompanyDraft[]): ItemCompanyView[];
  removeCompany(itemId: string, companyId: string): void;
  removeCompanies(itemId: string, companyIds: string[]): void;
  recognizeCompanies(itemId: string, text: string): Promise<CompanyDraft[]>;
  retryCompanyProfile(companyId: string): boolean;
}

export interface ConversationServiceLike {
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
}

export interface CompanyResearchServiceLike {
  start(itemId: string, companyId: string, input: StartCompanyResearchInput): Promise<ResearchRun>;
  cancel(runId: string): Promise<void>;
  getState(itemId: string, companyId: string): CompanyResearchState;
  listRuns(itemId: string, companyId: string): ResearchRunSummary[];
  getRun(itemId: string, companyId: string, runId: string): ResearchRun | undefined;
  retryStructuring(itemId: string, companyId: string, runId: string): Promise<ResearchRun>;
  subscribe(listener: (event: CompanyResearchEvent) => void): () => void;
}

export interface CompanyProfileEventSource {
  subscribe(listener: (event: CompanyProfileEvent) => void): () => void;
}

export interface ClipboardWriterLike {
  writeText(text: string): void | Promise<void>;
}

export interface IpcServiceDeps {
  ipcMain: IpcMainLike;
  conversations: ConversationServiceLike;
  industryResearch: IndustryResearchServiceLike;
  settings: ConfigurationServiceLike;
  skills: SkillListLike;
  chat: ChatServiceLike;
  companyResearch: CompanyResearchServiceLike;
  companyProfiles: CompanyProfileEventSource;
  clipboard: ClipboardWriterLike;
}

const INVOKE_CHANNELS = [
  IPC_CHANNELS.copyText,
  IPC_CHANNELS.industryResearchCreateItem,
  IPC_CHANNELS.industryResearchUpdateItem,
  IPC_CHANNELS.industryResearchDeleteItem,
  IPC_CHANNELS.industryResearchDeleteItems,
  IPC_CHANNELS.industryResearchListItems,
  IPC_CHANNELS.industryResearchGetItem,
  IPC_CHANNELS.industryResearchListCompanies,
  IPC_CHANNELS.industryResearchUpdateCompany,
  IPC_CHANNELS.industryResearchAddCompany,
  IPC_CHANNELS.industryResearchAddCompanies,
  IPC_CHANNELS.industryResearchRemoveCompany,
  IPC_CHANNELS.industryResearchRemoveCompanies,
  IPC_CHANNELS.industryResearchRecognizeCompanies,
  IPC_CHANNELS.industryResearchRetryCompanyProfile,
  IPC_CHANNELS.industryResearchSubscribeCompanyProfiles,
  IPC_CHANNELS.companyResearchStart,
  IPC_CHANNELS.companyResearchCancel,
  IPC_CHANNELS.companyResearchGetState,
  IPC_CHANNELS.companyResearchListRuns,
  IPC_CHANNELS.companyResearchGetRun,
  IPC_CHANNELS.companyResearchRetryStructuring,
  IPC_CHANNELS.companyResearchSubscribe,
  IPC_CHANNELS.conversationsCreate,
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

  const emitResearch = (event: CompanyResearchEvent): void => {
    if (!Value.Check(CompanyResearchEventSchema, event)) return;
    for (const sender of senders.values()) {
      sender.send(IPC_CHANNELS.companyResearchEvents, event);
    }
  };
  const unsubscribeResearch = deps.companyResearch.subscribe(emitResearch);
  const unsubscribeProfiles = deps.companyProfiles.subscribe((event) => {
    if (!Value.Check(CompanyProfileEventSchema, event)) return;
    for (const sender of senders.values()) {
      sender.send(IPC_CHANNELS.industryResearchCompanyProfileEvents, event);
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.copyText, async (_event, ...args) => {
    if (!Value.Check(CopyTextArgsSchema, args)) {
      throw new Error("invalid clipboard input");
    }
    await deps.clipboard.writeText(args[0]);
  });

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

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchUpdateCompany, async (_event, ...args) => {
    const companyId = args[0];
    const input = args[1];
    if (
      args.length !== 2 ||
      typeof companyId !== "string" ||
      companyId.length === 0 ||
      !Value.Check(CompanyProfileInputSchema, input) ||
      input.name.trim().length === 0
    ) {
      throw new Error("invalid company profile");
    }
    try {
      return deps.industryResearch.updateCompany(companyId, input);
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) {
        throw new Error("company name already exists");
      }
      throw new Error("company profile update failed");
    }
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

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchRetryCompanyProfile, (_event, ...args) => {
    const companyId = args[0];
    if (args.length !== 1 || typeof companyId !== "string" || companyId.length === 0) {
      throw new Error("invalid company input");
    }
    try {
      return deps.industryResearch.retryCompanyProfile(companyId);
    } catch {
      throw new Error("company profile retry failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.industryResearchSubscribeCompanyProfiles, async (event, ...args) => {
    if (args.length !== 0) throw new Error("invalid company profile subscription");
    trackSender(event.sender);
  });

  deps.ipcMain.handle(IPC_CHANNELS.companyResearchStart, async (event, ...args) => {
    if (args.length !== 3 || !Value.Check(CompanyResearchStartArgsSchema, args)) {
      throw new Error("invalid company research input");
    }
    trackSender(event.sender);
    try {
      return await deps.companyResearch.start(args[0], args[1], args[2]);
    } catch {
      throw new Error("company research start failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.companyResearchCancel, async (event, ...args) => {
    if (args.length !== 1 || !Value.Check(CompanyResearchCancelArgsSchema, args)) {
      throw new Error("invalid company research input");
    }
    trackSender(event.sender);
    try {
      return await deps.companyResearch.cancel(args[0]);
    } catch {
      throw new Error("company research cancellation failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.companyResearchGetState, async (event, ...args) => {
    if (args.length !== 2 || !Value.Check(CompanyResearchTargetArgsSchema, args)) {
      throw new Error("invalid company research input");
    }
    trackSender(event.sender);
    try {
      return deps.companyResearch.getState(args[0], args[1]);
    } catch {
      throw new Error("company research read failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.companyResearchListRuns, async (event, ...args) => {
    if (args.length !== 2 || !Value.Check(CompanyResearchTargetArgsSchema, args)) {
      throw new Error("invalid company research input");
    }
    trackSender(event.sender);
    try {
      return deps.companyResearch.listRuns(args[0], args[1]);
    } catch {
      throw new Error("company research read failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.companyResearchGetRun, async (event, ...args) => {
    if (args.length !== 3 || !Value.Check(CompanyResearchGetRunArgsSchema, args)) {
      throw new Error("invalid company research input");
    }
    trackSender(event.sender);
    try {
      return deps.companyResearch.getRun(args[0], args[1], args[2]);
    } catch {
      throw new Error("company research read failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.companyResearchRetryStructuring, async (event, ...args) => {
    if (args.length !== 3 || !Value.Check(CompanyResearchRetryStructuringArgsSchema, args)) {
      throw new Error("invalid company research input");
    }
    trackSender(event.sender);
    try {
      return await deps.companyResearch.retryStructuring(args[0], args[1], args[2]);
    } catch {
      throw new Error("company research structuring retry failed");
    }
  });

  deps.ipcMain.handle(IPC_CHANNELS.companyResearchSubscribe, async (event, ...args) => {
    if (args.length !== 0 || !Value.Check(CompanyResearchSubscribeArgsSchema, args)) {
      throw new Error("invalid company research input");
    }
    trackSender(event.sender);
  });

  deps.ipcMain.handle(IPC_CHANNELS.conversationsCreate, async (_event, ...args) => {
    if (args.length !== 0) {
      throw new Error("invalid conversation input");
    }
    return deps.conversations.create();
  });

  deps.ipcMain.handle(IPC_CHANNELS.conversationsDelete, async (_event, ...args) => {
    if (!Value.Check(ConversationDeleteArgsSchema, args)) {
      throw new Error("invalid conversation input");
    }
    deps.conversations.delete(args[0]);
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

  const settingsHandler = <T>(channel: string, schema: TSchema, call: (...args: any[]) => Promise<T>): void => {
    deps.ipcMain.handle(channel, async (_event, ...args) => {
      if (!Value.Check(schema, args)) throw new Error("invalid settings input");
      try { return await call(...args); }
      catch { throw new Error("settings operation failed"); }
    });
  };
  settingsHandler(IPC_CHANNELS.settingsGet, SettingsGetArgsSchema, () => deps.settings.get());
  settingsHandler(IPC_CHANNELS.settingsSaveLlmProfile, SettingsLlmDraftArgsSchema, (input: LlmProfileDraft) => deps.settings.saveLlmProfile(input));
  settingsHandler(IPC_CHANNELS.settingsActivateLlmProfile, SettingsProfileIdArgsSchema, (id: string | null) => deps.settings.activateLlmProfile(id));
  settingsHandler(IPC_CHANNELS.settingsDeleteLlmProfile, SettingsDeleteProfileArgsSchema, (id: string) => deps.settings.deleteLlmProfile(id));
  settingsHandler(IPC_CHANNELS.settingsDiagnoseLlm, SettingsLlmDraftArgsSchema, (input: LlmProfileDraft) => deps.settings.diagnoseLlm(input));
  settingsHandler(IPC_CHANNELS.settingsSaveSearchProfile, SettingsSearchDraftArgsSchema, (input: SearchProfileDraft) => deps.settings.saveSearchProfile(input));
  settingsHandler(IPC_CHANNELS.settingsActivateSearchProfile, SettingsProfileIdArgsSchema, (id: string | null) => deps.settings.activateSearchProfile(id));
  settingsHandler(IPC_CHANNELS.settingsDeleteSearchProfile, SettingsDeleteProfileArgsSchema, (id: string) => deps.settings.deleteSearchProfile(id));
  settingsHandler(IPC_CHANNELS.settingsDiagnoseSearch, SettingsSearchDraftArgsSchema, (input: SearchProfileDraft) => deps.settings.diagnoseSearch(input));

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
    unsubscribeResearch();
    unsubscribeProfiles();
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
