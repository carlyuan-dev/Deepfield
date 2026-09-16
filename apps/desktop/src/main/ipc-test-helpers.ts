import type {
  AgentWorkerEvent,
  CapabilityItem,
  CapabilityItemId,
  ChatMessage,
  ChatRequestOptions,
  CompanyDraft,
  Company,
  CompanyResearchState,
  CompanyResearchEvent,
  KeyResearchRun,
  ResearchRunSummary,
  CompanyProfileEvent,
  CompanyId,
  Conversation,
  ConversationId,
  ItemCompanyView,
  SkillSummary,
  LlmProfileDraft,
  SearchProfileDraft,
  SettingsView,
  DiagnosticResult,
  ResearchRun,
  ResearchRunId,
  CompanyResearchWordExportResult,
  StartCompanyResearchInput,
} from "@deepfield/contracts";
import { getCompanyResearchTemplate } from "@deepfield/contracts";
import { vi } from "vitest";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  registerIpcHandlers,
  type IpcMainLike,
  type IpcServiceDeps,
  type WebContentsLike,
} from "./ipc.js";

// IPC only imports the setting name. Application services are supplied below,
// so focused boundary tests do not need to load the Application barrel.
vi.mock("@deepfield/application", () => ({ DEEPSEEK_KEY_NAME: "deepseek.apiKey" }));

export class FakeWebContents implements WebContentsLike {
  sent: Array<{ channel: string; payload: unknown }> = [];
  destroyedListenerCount = 0;
  private destroyedListeners = new Set<() => void>();

  constructor(public readonly id: number) {}

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  on(event: "destroyed", listener: () => void): void {
    this.destroyedListenerCount += 1;
    this.destroyedListeners.add(listener);
  }

  removeListener(event: "destroyed", listener: () => void): void {
    this.destroyedListenerCount -= 1;
    this.destroyedListeners.delete(listener);
  }

  destroy(): void {
    for (const listener of [...this.destroyedListeners]) {
      listener();
    }
  }
}

export class FakeIpcMain implements IpcMainLike {
  handlers = new Map<
    string,
    (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown
  >();

  handle(
    channel: string,
    listener: (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown,
  ): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  async invoke(
    channel: string,
    event: { sender: WebContentsLike },
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`no handler registered for ${channel}`);
    }
    return handler(event, ...args);
  }
}

export class FakeIndustryResearchService {
  createItemCalls: unknown[] = [];
  updateItemCalls: Array<{ itemId: string; input: unknown }> = [];
  deleteItemCalls: string[] = [];
  deleteItemsCalls: string[][] = [];
  listItemsCalls = 0;
  getItemCalls: string[] = [];
  listCompaniesCalls: string[] = [];
  updateCompanyCalls: Array<{ companyId: string; input: unknown }> = [];
  addCompanyCalls: Array<{ itemId: string; draft: CompanyDraft }> = [];
  addCompaniesCalls: Array<{ itemId: string; drafts: CompanyDraft[] }> = [];
  removeCompanyCalls: Array<{ itemId: string; companyId: string }> = [];
  removeCompaniesCalls: Array<{ itemId: string; companyIds: string[] }> = [];
  recognizeCompaniesCalls: Array<{ itemId: string; text: string }> = [];
  recognizeCompaniesCallsResult: CompanyDraft[] = [];
  retryCompanyProfileCalls: string[] = [];
  confirmCompanyProfileIdentityCalls: Array<{ companyId: string; hint: unknown }> = [];

  createItem(input: unknown): CapabilityItem {
    this.createItemCalls.push(input);
    const value = input as { industry: string; researchScope?: string; notes?: string };
    return {
      id: "item-1" as CapabilityItemId,
      type: "industry-research",
      industry: value.industry,
      ...(value.researchScope !== undefined ? { researchScope: value.researchScope } : {}),
      ...(value.notes !== undefined ? { notes: value.notes } : {}),
      createdAt: "",
      updatedAt: "",
    };
  }

  updateItem(itemId: string, input: unknown): CapabilityItem {
    this.updateItemCalls.push({ itemId, input });
    const value = input as { industry: string; researchScope?: string; notes?: string };
    return {
      id: itemId as CapabilityItemId,
      type: "industry-research",
      industry: value.industry,
      ...(value.researchScope !== undefined ? { researchScope: value.researchScope } : {}),
      ...(value.notes !== undefined ? { notes: value.notes } : {}),
      createdAt: "",
      updatedAt: "",
    };
  }

  deleteItem(itemId: string): void {
    this.deleteItemCalls.push(itemId);
  }

  deleteItems(itemIds: string[]): void {
    this.deleteItemsCalls.push(itemIds);
  }

  listItems(): CapabilityItem[] {
    this.listItemsCalls += 1;
    return [];
  }

  getItem(itemId: string): CapabilityItem | undefined {
    this.getItemCalls.push(itemId);
    return undefined;
  }

  listCompanies(itemId: string): ItemCompanyView[] {
    this.listCompaniesCalls.push(itemId);
    return [];
  }

  updateCompany(companyId: string, input: unknown): Company {
    this.updateCompanyCalls.push({ companyId, input });
    const value = input as { name: string; headquarters?: string };
    return {
      id: companyId as CompanyId,
      name: value.name,
      normalizedName: value.name.toLowerCase(),
      profileStatus: "ready",
      ...(value.headquarters !== undefined ? { headquarters: value.headquarters } : {}),
      createdAt: "",
      updatedAt: "",
    };
  }

  addCompany(itemId: string, draft: CompanyDraft): ItemCompanyView {
    this.addCompanyCalls.push({ itemId, draft });
    return this.companyView(itemId, draft);
  }

  addCompanies(itemId: string, drafts: CompanyDraft[]): ItemCompanyView[] {
    this.addCompaniesCalls.push({ itemId, drafts });
    return drafts.map((draft) => this.companyView(itemId, draft));
  }

  removeCompany(itemId: string, companyId: string): void {
    this.removeCompanyCalls.push({ itemId, companyId });
  }

  removeCompanies(itemId: string, companyIds: string[]): void {
    this.removeCompaniesCalls.push({ itemId, companyIds });
  }

  recognizeCompanies(itemId: string, text: string): Promise<CompanyDraft[]> {
    this.recognizeCompaniesCalls.push({ itemId, text });
    return Promise.resolve(this.recognizeCompaniesCallsResult);
  }

  retryCompanyProfile(companyId: string): boolean {
    this.retryCompanyProfileCalls.push(companyId);
    return true;
  }

  confirmCompanyProfileIdentity(companyId: string, hint: unknown): boolean {
    this.confirmCompanyProfileIdentityCalls.push({ companyId, hint });
    return true;
  }

  private companyView(itemId: string, draft: CompanyDraft): ItemCompanyView {
    return {
      id: "company-1" as CompanyId,
      name: draft.name,
      normalizedName: draft.name.toLowerCase(),
      profileStatus: "ready",
      itemId: itemId as CapabilityItemId,
      ...(draft.note !== undefined ? { note: draft.note } : {}),
      createdAt: "",
      updatedAt: "",
    };
  }
}

export class FakeConversationService {
  createCalls = 0;
  openInitialCalls = 0;
  listRecentCalls = 0;
  deleteCalls: string[] = [];
  recent: Conversation[] = [];
  initialActive: Conversation | undefined;

  makeConversation(id: string, title = "新对话", hasUserMessage = false): Conversation {
    return {
      id: id as ConversationId,
      title,
      hasUserMessage,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  create(): Conversation {
    this.createCalls += 1;
    const created = this.makeConversation(`c-created-${this.createCalls}`);
    this.initialActive = created;
    return created;
  }

  delete(conversationId: string): void {
    this.deleteCalls.push(conversationId);
  }

  openInitial(): { active: Conversation; recent: Conversation[] } {
    this.openInitialCalls += 1;
    const active = this.initialActive ?? this.create();
    return { active, recent: this.recent };
  }

  listRecent(): Conversation[] {
    this.listRecentCalls += 1;
    return this.recent;
  }
}

export class FakeConfigurationService {
  calls: Array<{ method: string; value?: unknown }> = [];
  view: SettingsView = { schemaVersion: 1, llm: { activeProfileId: null, profiles: [] }, search: { activeProfileId: null, profiles: [], manifests: [] } };
  get(): Promise<SettingsView> { this.calls.push({ method: "get" }); return Promise.resolve(this.view); }
  saveLlmProfile(value: LlmProfileDraft): Promise<SettingsView> { this.calls.push({ method: "saveLlmProfile", value }); return Promise.resolve(this.view); }
  activateLlmProfile(value: string | null): Promise<SettingsView> { this.calls.push({ method: "activateLlmProfile", value }); return Promise.resolve(this.view); }
  deleteLlmProfile(value: string): Promise<SettingsView> { this.calls.push({ method: "deleteLlmProfile", value }); return Promise.resolve(this.view); }
  diagnoseLlm(value: LlmProfileDraft): Promise<DiagnosticResult> { this.calls.push({ method: "diagnoseLlm", value }); return Promise.resolve({ ok: true, latencyMs: 1, summary: "ok" }); }
  saveSearchProfile(value: SearchProfileDraft): Promise<SettingsView> { this.calls.push({ method: "saveSearchProfile", value }); return Promise.resolve(this.view); }
  activateSearchProfile(value: string | null): Promise<SettingsView> { this.calls.push({ method: "activateSearchProfile", value }); return Promise.resolve(this.view); }
  deleteSearchProfile(value: string): Promise<SettingsView> { this.calls.push({ method: "deleteSearchProfile", value }); return Promise.resolve(this.view); }
  diagnoseSearch(value: SearchProfileDraft): Promise<DiagnosticResult> { this.calls.push({ method: "diagnoseSearch", value }); return Promise.resolve({ ok: true, latencyMs: 1, summary: "ok" }); }
}

export const DEFAULT_CHAT_OPTIONS: ChatRequestOptions = { webSearch: false };

export class FakeSkillList {
  listCalls = 0;
  summaries: SkillSummary[] = [];

  list(): SkillSummary[] {
    this.listCalls += 1;
    return this.summaries;
  }
}

export class FakeChatService {
  sendCalls: Array<{
    conversationId: string;
    content: string;
    requestId: string;
    options: ChatRequestOptions;
  }> = [];
  listMessagesCalls: string[] = [];
  history: ChatMessage[] = [];
  private listeners: Array<(event: AgentWorkerEvent) => void> = [];

  send(
    conversationId: string,
    content: string,
    requestId: string,
    onEvent: (event: AgentWorkerEvent) => void,
    options: ChatRequestOptions,
  ) {
    this.sendCalls.push({ conversationId, content, requestId, options });
    this.listeners.push(onEvent);
    return Promise.resolve({
      requestId,
      conversation: {
        id: conversationId as ConversationId,
        title: content.slice(0, 28),
        hasUserMessage: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
  }

  listMessages(conversationId: string): ChatMessage[] {
    this.listMessagesCalls.push(conversationId);
    return this.history;
  }

  emitToLast(event: AgentWorkerEvent): void {
    this.listeners[this.listeners.length - 1]?.(event);
  }
}

export class FakeCompanyResearchService {
  startCalls: Array<{ itemId: string; companyId: string; input: StartCompanyResearchInput }> = [];
  cancelCalls: string[] = [];
  getStateCalls: Array<{ itemId: string; companyId: string }> = [];
  listRunsCalls: Array<{ itemId: string; companyId: string }> = [];
  getRunCalls: Array<{ itemId: string; companyId: string; runId: string }> = [];
  retryFailedCalls: Array<{ itemId: string; companyId: string; runId: string; input: StartCompanyResearchInput }> = [];
  deleteRunCalls: Array<{ itemId: string; companyId: string; runId: string }> = [];
  run: ResearchRun = researchRun();
  runs: ResearchRunSummary[] = [];
  private listeners = new Set<(event: CompanyResearchEvent) => void>();

  async start(itemId: string, companyId: string, input: StartCompanyResearchInput): Promise<ResearchRun> {
    this.startCalls.push({ itemId, companyId, input });
    return researchRun({ itemId: itemId as CapabilityItemId, companyId: companyId as CompanyId, ...input });
  }

  async cancel(runId: string): Promise<void> {
    this.cancelCalls.push(runId);
  }

  getState(itemId: string, companyId: string): CompanyResearchState {
    this.getStateCalls.push({ itemId, companyId });
    return { runs: this.runs, globalActiveRun: null };
  }

  listRuns(itemId: string, companyId: string): ResearchRunSummary[] {
    this.listRunsCalls.push({ itemId, companyId });
    return this.runs;
  }

  getRun(itemId: string, companyId: string, runId: string): ResearchRun | undefined {
    this.getRunCalls.push({ itemId, companyId, runId });
    if (runId !== this.run.id) return undefined;
    if (itemId !== this.run.itemId || companyId !== this.run.companyId) {
      throw new Error(`wrong target: ${JSON.stringify(this.run)}`);
    }
    return this.run;
  }

  async retryFailed(itemId: string, companyId: string, runId: string, input: StartCompanyResearchInput): Promise<ResearchRun> {
    this.retryFailedCalls.push({ itemId, companyId, runId, input });
    return researchRun({ id: runId as ResearchRunId, itemId: itemId as CapabilityItemId, companyId: companyId as CompanyId, ...input });
  }

  deleteRun(itemId: string, companyId: string, runId: string): void {
    this.deleteRunCalls.push({ itemId, companyId, runId });
  }

  subscribe(listener: (event: CompanyResearchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: unknown): void {
    // Deliberately permit malformed transport fixtures to exercise IPC filtering.
    for (const listener of this.listeners) listener(event as CompanyResearchEvent);
  }
}

export class FakeCompanyResearchWordExportService {
  exportCalls: Array<{ itemId: string; companyId: string; runId: string; selection: { raw: boolean; structured: boolean } }> = [];
  result: CompanyResearchWordExportResult = { status: "cancelled" };
  error: Error | undefined;

  async export(itemId: string, companyId: string, runId: string, selection: { raw: boolean; structured: boolean }): Promise<CompanyResearchWordExportResult> {
    this.exportCalls.push({ itemId, companyId, runId, selection });
    if (this.error) throw this.error;
    return this.result;
  }
}

export const RESEARCH_INPUT: StartCompanyResearchInput = {
  direction: "product_and_technology", focusScope: "整机", asOfDate: "2026-09-11",
};

export function researchRun(overrides: Partial<KeyResearchRun> = {}): KeyResearchRun {
  return {
    id: "run-1" as ResearchRunId,
    itemId: "item-1" as CapabilityItemId,
    companyId: "company-1" as CompanyId,
    schemaVersion: "company-research-report-v1",
    status: "researching",
    ...RESEARCH_INPUT,
    researchContext: { ...RESEARCH_INPUT, currentDate: "2026-09-11", companyName: "ACME", topicName: "机器人" },
    template: getCompanyResearchTemplate(RESEARCH_INPUT.direction),
    harnessVersion: 1,
    structuringAttempts: 0,
    createdAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

export class FakeCompanyProfileEventSource {
  configurationChangeCalls = 0;
  configurationChanged(): void { this.configurationChangeCalls += 1; }
  listeners = new Set<(event: CompanyProfileEvent) => void>();
  subscribe(listener: (event: CompanyProfileEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: CompanyProfileEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export class FakeClipboardWriter {
  writeTextCalls: string[] = [];
  writeError: Error | undefined;

  writeText(text: string): void {
    this.writeTextCalls.push(text);
    if (this.writeError) throw this.writeError;
  }
}

export function makeDeps() {
  const ipcMain = new FakeIpcMain();
  const conversations = new FakeConversationService();
  const industryResearch = new FakeIndustryResearchService();
  const settings = new FakeConfigurationService();
  const skills = new FakeSkillList();
  const chat = new FakeChatService();
  const companyResearch = new FakeCompanyResearchService();
  const companyResearchWordExport = new FakeCompanyResearchWordExportService();
  const companyProfiles = new FakeCompanyProfileEventSource();
  const clipboard = new FakeClipboardWriter();
  const deps: IpcServiceDeps = {
    ipcMain,
    conversations,
    industryResearch,
    settings,
    skills,
    chat,
    companyResearch,
    companyResearchWordExport,
    companyProfiles,
    clipboard,
  };
  const dispose = registerIpcHandlers(deps);
  return { ipcMain, conversations, industryResearch, settings, skills, chat, companyResearch, companyResearchWordExport, companyProfiles, clipboard, dispose };
}

export const event = (sender: WebContentsLike): { sender: WebContentsLike } => ({ sender });

export const workerEvent = (requestId = "req-1"): AgentWorkerEvent => ({
  requestId,
  type: "text_delta",
  delta: "测",
});

export const channels = IPC_CHANNELS;
