// @vitest-environment jsdom
import { vi, type Mock } from "vitest";
import type { UsageDashboard, UsageDashboardApi } from "@deepfield/base/usage";
import type {
  AgentWorkerEvent,
  CapabilityItem,
  CapabilityItemId,
  Company,
  CompanyProfileInput,
  CompanyProfileIdentityHint,
  CompanyProfileEvent,
  ChatMessage,
  ChatRequestOptions,
  ChatSendResult,
  Conversation,
  ConversationId,
  DesktopApi,
  CompanyDraft,
  CompanyResearchState,
  CompanyResearchEvent,
  ResearchRunSummary,
  ItemCompanyView,
  MessageId,
  SkillSummary,
  LlmProfileDraft,
  SearchProfileDraft,
  SettingsView,
  DiagnosticResult,
  ResearchRun,
  StartCompanyResearchInput,
} from "@deepfield/contracts";

export interface FakeDesktopApi extends DesktopApi {
  usage: { getDashboard: Mock<UsageDashboardApi["getDashboard"]> };
  companyResearchBatch: { [K in keyof DesktopApi["companyResearchBatch"]]: Mock<DesktopApi["companyResearchBatch"][K]> };
  conversations: {
    setWebSearchEnabled: Mock<DesktopApi["conversations"]["setWebSearchEnabled"]>;
    create: Mock<() => Promise<Conversation>>;
    delete: Mock<(id: string) => Promise<void>>;
    openInitial: Mock<() => Promise<{ active: Conversation; recent: Conversation[] }>>;
    listRecent: Mock<() => Promise<Conversation[]>>;
    subscribe: Mock<(listener: (conversation: Conversation) => void) => () => void>;
  };
  industryResearch: {
    getCompanyProfileProgress: Mock<DesktopApi["industryResearch"]["getCompanyProfileProgress"]>;
    subscribeCompanyProfileProgress: Mock<DesktopApi["industryResearch"]["subscribeCompanyProfileProgress"]>;
    createItem: Mock<(input: { industry: string; researchScope?: string; notes?: string }) => Promise<CapabilityItem>>;
    updateItem: Mock<(itemId: string, input: { industry: string; researchScope?: string; notes?: string }) => Promise<CapabilityItem>>;
    deleteItem: Mock<(itemId: string) => Promise<void>>;
    deleteItems: Mock<(itemIds: string[]) => Promise<void>>;
    listItems: Mock<() => Promise<CapabilityItem[]>>;
    getItem: Mock<(itemId: string) => Promise<CapabilityItem | undefined>>;
    listCompanies: Mock<(itemId: string) => Promise<ItemCompanyView[]>>;
    updateCompany: Mock<(companyId: string, input: CompanyProfileInput) => Promise<Company>>;
    addCompany: Mock<(itemId: string, draft: CompanyDraft) => Promise<ItemCompanyView>>;
    addCompanies: Mock<(itemId: string, drafts: CompanyDraft[]) => Promise<ItemCompanyView[]>>;
    removeCompany: Mock<(itemId: string, companyId: string) => Promise<void>>;
    removeCompanies: Mock<(itemId: string, companyIds: string[]) => Promise<void>>;
    recognizeCompanies: Mock<(itemId: string, text: string) => Promise<CompanyDraft[]>>;
    retryCompanyProfile: Mock<(companyId: string) => Promise<boolean>>;
    confirmCompanyProfileIdentity: Mock<(companyId: string, hint: CompanyProfileIdentityHint) => Promise<boolean>>;
    subscribeCompanyProfiles: Mock<(listener: (event: CompanyProfileEvent) => void) => () => void>;
  };
  companyResearch: {
    start: Mock<(itemId: string, companyId: string, input: StartCompanyResearchInput) => Promise<ResearchRun>>;
    cancel: Mock<(runId: string) => Promise<void>>;
    getState: Mock<(itemId: string, companyId: string) => Promise<CompanyResearchState>>;
    listRuns: Mock<(itemId: string, companyId: string) => Promise<ResearchRunSummary[]>>;
    getRun: Mock<(itemId: string, companyId: string, runId: string) => Promise<ResearchRun | undefined>>;
    retryStructuring: Mock<(itemId: string, companyId: string, runId: string) => Promise<ResearchRun>>;
    retryFailed: Mock<(itemId: string, companyId: string, runId: string, input: StartCompanyResearchInput) => Promise<ResearchRun>>;
    deleteRun: Mock<(itemId: string, companyId: string, runId: string) => Promise<void>>;
    exportWord: Mock<(itemId: string, companyId: string, runId: string, selection: { raw: boolean; structured: boolean }) => Promise<{ status: "saved" | "cancelled" }>>;
    subscribe: Mock<(listener: (event: CompanyResearchEvent) => void) => () => void>;
  };
  settings: {
    get: Mock<() => Promise<SettingsView>>;
    saveLlmProfile: Mock<(input: LlmProfileDraft) => Promise<SettingsView>>;
    activateLlmProfile: Mock<(id: string | null) => Promise<SettingsView>>;
    deleteLlmProfile: Mock<(id: string) => Promise<SettingsView>>;
    diagnoseLlm: Mock<(input: LlmProfileDraft) => Promise<DiagnosticResult>>;
    saveSearchProfile: Mock<(input: SearchProfileDraft) => Promise<SettingsView>>;
    activateSearchProfile: Mock<(id: string | null) => Promise<SettingsView>>;
    deleteSearchProfile: Mock<(id: string) => Promise<SettingsView>>;
    diagnoseSearch: Mock<(input: SearchProfileDraft) => Promise<DiagnosticResult>>;
  };
  skills: {
    list: Mock<() => Promise<SkillSummary[]>>;
  };
  chat: {
    send: Mock<
      (
        conversationId: string,
        content: string,
        requestId: string,
        options: ChatRequestOptions,
      ) => Promise<ChatSendResult>
    >;
    subscribe: Mock<(listener: (event: AgentWorkerEvent) => void) => () => void>;
    listMessages: Mock<(conversationId: string) => Promise<ChatMessage[]>>;
  };
  listeners: Set<(event: AgentWorkerEvent) => void>;
  conversationListeners: Set<(conversation: Conversation) => void>;
  researchListeners: Set<(event: CompanyResearchEvent) => void>;
  emit(event: AgentWorkerEvent): void;
  emitConversation(conversation: Conversation): void;
  emitResearch(event: CompanyResearchEvent): void;
  emitProfile(event: CompanyProfileEvent): void;
  nextRequestId(): string;
}

let sendSeq = 0;

function conversationFixture(): Conversation {
  return {
    id: `c-${++sendSeq}` as ConversationId,
    title: "新对话",
    hasUserMessage: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function conversation(
  id: string,
  title = "新对话",
  hasUserMessage = false,
): Conversation {
  return {
    id: id as ConversationId,
    title,
    hasUserMessage,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function chatSendResult(
  requestId: string,
  conversationId = "conv-1",
  title = "新对话",
): ChatSendResult {
  return {
    requestId,
    conversation: conversation(conversationId, title, true),
  };
}

export function makeFakeApi(): FakeDesktopApi {
  const listeners = new Set<(event: AgentWorkerEvent) => void>();
  const conversationListeners = new Set<(conversation: Conversation) => void>();
  const researchListeners = new Set<(event: CompanyResearchEvent) => void>();
  const profileListeners = new Set<(event: CompanyProfileEvent) => void>();
  const api = {
    usage: {
      getDashboard: vi.fn(async (): Promise<UsageDashboard> => ({
        summary: {
          requests: 0,
          running: 0,
          succeeded: 0,
          failed: 0,
          cancelled: 0,
          interrupted: 0,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: null,
          resultCount: null,
          reportedUsageRequests: 0,
          unknownUsageRequests: 0,
          partialUsageRequests: 0,
          incompleteAttemptCountRequests: 0,
        },
        daily: [],
        trend: {
          granularity: "day",
          points: [],
          summary: {
            requests: 0,
            running: 0,
            succeeded: 0,
            failed: 0,
            cancelled: 0,
            interrupted: 0,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            totalTokens: null,
            resultCount: null,
            reportedUsageRequests: 0,
            unknownUsageRequests: 0,
            partialUsageRequests: 0,
            incompleteAttemptCountRequests: 0,
            inputCacheHitTokens: null,
            inputCacheMissTokens: null,
            inputCacheUnknownTokens: null,
            cacheSplitUnknownRequests: 0,
          },
          models: [],
          selectedModel: null,
        },
        providers: [],
        health: {
          collectionStartedAt: "2026-09-01T00:00:00.000Z",
          lastInitializedAt: "2026-09-01T00:00:00.000Z",
          cleanShutdown: true,
          previousUncleanShutdown: false,
          interruptedRequests: 0,
          pendingRecords: 0,
          failedRecords: 0,
          droppedRecords: 0,
          lastErrorCode: null,
          degraded: false,
        },
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-10-01T00:00:00.000Z",
        timeZone: "Asia/Shanghai",
      })),
    },
    copyText: vi.fn(async (): Promise<void> => {}),
    conversations: {
      setWebSearchEnabled: vi.fn(async (id: string, enabled: boolean): Promise<Conversation> => ({
        ...conversationFixture(), id: id as Conversation["id"], webSearchEnabled: enabled,
      })),
      create: vi.fn(async (): Promise<Conversation> => conversationFixture()),
      delete: vi.fn(async (): Promise<void> => {}),
      openInitial: vi.fn(
        async (): Promise<{ active: Conversation; recent: Conversation[] }> => {
          const active = conversationFixture();
          return { active, recent: [] };
        },
      ),
      listRecent: vi.fn(async (): Promise<Conversation[]> => []),
      subscribe: vi.fn((listener: (conversation: Conversation) => void) => {
        conversationListeners.add(listener);
        return () => conversationListeners.delete(listener);
      }),
    },
    industryResearch: {
      getCompanyProfileProgress: vi.fn(async (itemId: string) => ({ itemId, status: "idle" as const, processed: 0, total: 0, failed: 0 })),
      subscribeCompanyProfileProgress: vi.fn(() => () => {}),
      createItem: vi.fn(async (input: { industry: string; researchScope?: string; notes?: string }): Promise<CapabilityItem> => ({
        id: `item-${++sendSeq}` as CapabilityItemId,
        type: "industry-research",
        industry: input.industry,
        ...(input.researchScope !== undefined ? { researchScope: input.researchScope } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      updateItem: vi.fn(async (itemId: string, input: { industry: string; researchScope?: string; notes?: string }): Promise<CapabilityItem> => ({
        id: itemId as CapabilityItemId,
        type: "industry-research",
        industry: input.industry,
        ...(input.researchScope !== undefined ? { researchScope: input.researchScope } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      deleteItem: vi.fn(async (): Promise<void> => {}),
      deleteItems: vi.fn(async (): Promise<void> => {}),
      listItems: vi.fn(async (): Promise<CapabilityItem[]> => []),
      getItem: vi.fn(async (): Promise<CapabilityItem | undefined> => undefined),
      listCompanies: vi.fn(async (): Promise<ItemCompanyView[]> => []),
      updateCompany: vi.fn(async (): Promise<Company> => {
        throw new Error("not implemented");
      }),
      addCompany: vi.fn(async (): Promise<ItemCompanyView> => {
        throw new Error("not implemented");
      }),
      addCompanies: vi.fn(async (): Promise<ItemCompanyView[]> => []),
      removeCompany: vi.fn(async (): Promise<void> => {}),
      removeCompanies: vi.fn(async (): Promise<void> => {}),
      recognizeCompanies: vi.fn(async (): Promise<CompanyDraft[]> => []),
      retryCompanyProfile: vi.fn(async (): Promise<boolean> => true),
      confirmCompanyProfileIdentity: vi.fn(async (): Promise<boolean> => true),
      subscribeCompanyProfiles: vi.fn((listener: (event: CompanyProfileEvent) => void) => {
        profileListeners.add(listener);
        return () => profileListeners.delete(listener);
      }),
    },
    companyResearchBatch: {
      start: vi.fn(async () => { throw new Error("batch start not configured"); }), getState: vi.fn(async () => null), cancel: vi.fn(async () => {}), resume: vi.fn(async () => { throw new Error("batch resume not configured"); }), subscribe: vi.fn(() => () => {}),
    },
    companyResearch: {
      start: vi.fn(async (): Promise<ResearchRun> => {
        throw new Error("not implemented");
      }),
      cancel: vi.fn(async (): Promise<void> => {}),
      getState: vi.fn(async (): Promise<CompanyResearchState> => ({ runs: [], globalActiveRun: null })),
      listRuns: vi.fn(async (): Promise<ResearchRunSummary[]> => []),
      getRun: vi.fn(async (): Promise<ResearchRun | undefined> => undefined),
      retryStructuring: vi.fn(async (): Promise<ResearchRun> => { throw new Error("not implemented"); }),
      retryFailed: vi.fn(async (): Promise<ResearchRun> => { throw new Error("not implemented"); }),
      deleteRun: vi.fn(async (): Promise<void> => {}),
      exportWord: vi.fn(async () => ({ status: "saved" as const })),
      subscribe: vi.fn(
        (listener: (event: CompanyResearchEvent) => void): (() => void) => {
          researchListeners.add(listener);
          return () => researchListeners.delete(listener);
        },
      ),
    },
    settings: (() => {
      const view: SettingsView = { schemaVersion: 1, llm: { activeProfileId: null, profiles: [] }, search: { activeProfileId: null, profiles: [], manifests: [] } };
      return {
        get: vi.fn(async () => view),
        saveLlmProfile: vi.fn(async () => view), activateLlmProfile: vi.fn(async () => view), deleteLlmProfile: vi.fn(async () => view), diagnoseLlm: vi.fn(async () => ({ ok: true, latencyMs: 1, summary: "模型连接正常" } as const)),
        saveSearchProfile: vi.fn(async () => view), activateSearchProfile: vi.fn(async () => view), deleteSearchProfile: vi.fn(async () => view), diagnoseSearch: vi.fn(async () => ({ ok: true, latencyMs: 1, summary: "搜索连接正常" } as const)),
      };
    })(),
    skills: {
      list: vi.fn(async (): Promise<SkillSummary[]> => []),
    },
    chat: {
      send: vi.fn(
        async (
          conversationId: string,
          _content: string,
          requestId: string,
          _options: ChatRequestOptions,
        ): Promise<ChatSendResult> => {
          const conversation: Conversation = {
            id: conversationId as ConversationId,
            title: "新对话",
            hasUserMessage: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          };
          return { requestId, conversation };
        },
      ),
      subscribe: vi.fn((listener: (event: AgentWorkerEvent) => void): (() => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
      listMessages: vi.fn(async (_projectId: string): Promise<ChatMessage[]> => []),
    },
    listeners,
    conversationListeners,
    researchListeners,
    emit: (event: AgentWorkerEvent): void => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    emitConversation: (conversation: Conversation): void => {
      for (const listener of [...conversationListeners]) listener(conversation);
    },
    emitResearch: (event: CompanyResearchEvent): void => {
      for (const listener of [...researchListeners]) listener(event);
    },
    emitProfile: (event: CompanyProfileEvent): void => {
      for (const listener of [...profileListeners]) listener(event);
    },
    nextRequestId: (): string => `req-${++sendSeq}`,
  };
  return api as unknown as FakeDesktopApi;
}

export function capabilityItem(
  overrides: { id?: string } & Partial<Omit<CapabilityItem, "id">> = {},
): CapabilityItem {
  const { id, ...rest } = overrides;
  return {
    id: (id ?? "item-1") as CapabilityItemId,
    type: "industry-research",
    industry: "人形机器人",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...rest,
  };
}

export function chatMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
): ChatMessage {
  return {
    id: id as MessageId,
    conversationId: "c1" as ConversationId,
    role,
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

export function workerEvent(
  requestId: string,
  type: "started" | "text_delta" | "completed" | "failed",
  payload?: string,
): AgentWorkerEvent {
  switch (type) {
    case "started":
      return { requestId, type: "started" };
    case "text_delta":
      return { requestId, type: "text_delta", delta: payload ?? "" };
    case "completed":
      return { requestId, type: "completed", text: payload ?? "" };
    case "failed":
      return { requestId, type: "failed", code: payload ?? "error", message: "boom" };
  }
}
