// @vitest-environment jsdom
import { vi, type Mock } from "vitest";
import type {
  AgentWorkerEvent,
  CapabilityItem,
  CapabilityItemId,
  ChatMessage,
  ChatRequestOptions,
  ChatSendResult,
  Conversation,
  ConversationId,
  DesktopApi,
  CompanyDraft,
  CompanyResearchState,
  CompanyResearchWorkerEvent,
  ItemCompanyView,
  MessageId,
  SkillSummary,
  LlmConnectionStatus,
  ResearchRun,
  StartCompanyResearchInput,
} from "@deepfield/contracts";

export interface FakeDesktopApi extends DesktopApi {
  conversations: {
    create: Mock<() => Promise<Conversation>>;
    openInitial: Mock<() => Promise<{ active: Conversation; recent: Conversation[] }>>;
    listRecent: Mock<() => Promise<Conversation[]>>;
  };
  industryResearch: {
    createItem: Mock<(input: { industry: string; researchScope?: string; notes?: string }) => Promise<CapabilityItem>>;
    updateItem: Mock<(itemId: string, input: { industry: string; researchScope?: string; notes?: string }) => Promise<CapabilityItem>>;
    deleteItem: Mock<(itemId: string) => Promise<void>>;
    deleteItems: Mock<(itemIds: string[]) => Promise<void>>;
    listItems: Mock<() => Promise<CapabilityItem[]>>;
    getItem: Mock<(itemId: string) => Promise<CapabilityItem | undefined>>;
    listCompanies: Mock<(itemId: string) => Promise<ItemCompanyView[]>>;
    addCompany: Mock<(itemId: string, draft: CompanyDraft) => Promise<ItemCompanyView>>;
    addCompanies: Mock<(itemId: string, drafts: CompanyDraft[]) => Promise<ItemCompanyView[]>>;
    removeCompany: Mock<(itemId: string, companyId: string) => Promise<void>>;
    removeCompanies: Mock<(itemId: string, companyIds: string[]) => Promise<void>>;
    recognizeCompanies: Mock<(itemId: string, text: string) => Promise<CompanyDraft[]>>;
  };
  companyResearch: {
    start: Mock<(itemId: string, companyId: string, input: StartCompanyResearchInput) => Promise<ResearchRun>>;
    cancel: Mock<(runId: string) => Promise<void>>;
    getState: Mock<(itemId: string, companyId: string) => Promise<CompanyResearchState>>;
    listCompleted: Mock<(itemId: string, companyId: string) => Promise<ResearchRun[]>>;
    subscribe: Mock<(listener: (event: CompanyResearchWorkerEvent) => void) => () => void>;
  };
  settings: {
    hasDeepSeekKey: Mock<() => Promise<boolean>>;
    setDeepSeekKey: Mock<(value: string) => Promise<void>>;
  };
  llm: {
    checkConnection: Mock<() => Promise<LlmConnectionStatus>>;
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
  researchListeners: Set<(event: CompanyResearchWorkerEvent) => void>;
  emit(event: AgentWorkerEvent): void;
  emitResearch(event: CompanyResearchWorkerEvent): void;
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
  const researchListeners = new Set<(event: CompanyResearchWorkerEvent) => void>();
  const api = {
    conversations: {
      create: vi.fn(async (): Promise<Conversation> => conversationFixture()),
      openInitial: vi.fn(
        async (): Promise<{ active: Conversation; recent: Conversation[] }> => {
          const active = conversationFixture();
          return { active, recent: [] };
        },
      ),
      listRecent: vi.fn(async (): Promise<Conversation[]> => []),
    },
    industryResearch: {
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
      addCompany: vi.fn(async (): Promise<ItemCompanyView> => {
        throw new Error("not implemented");
      }),
      addCompanies: vi.fn(async (): Promise<ItemCompanyView[]> => []),
      removeCompany: vi.fn(async (): Promise<void> => {}),
      removeCompanies: vi.fn(async (): Promise<void> => {}),
      recognizeCompanies: vi.fn(async (): Promise<CompanyDraft[]> => []),
    },
    companyResearch: {
      start: vi.fn(async (): Promise<ResearchRun> => {
        throw new Error("not implemented");
      }),
      cancel: vi.fn(async (): Promise<void> => {}),
      getState: vi.fn(async (): Promise<CompanyResearchState> => ({ completed: [] })),
      listCompleted: vi.fn(async (): Promise<ResearchRun[]> => []),
      subscribe: vi.fn(
        (listener: (event: CompanyResearchWorkerEvent) => void): (() => void) => {
          researchListeners.add(listener);
          return () => researchListeners.delete(listener);
        },
      ),
    },
    settings: {
      hasDeepSeekKey: vi.fn(async (): Promise<boolean> => false),
      setDeepSeekKey: vi.fn(async (_value: string): Promise<void> => {}),
    },
    llm: {
      checkConnection: vi.fn(async (): Promise<LlmConnectionStatus> => "disconnected"),
    },
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
    researchListeners,
    emit: (event: AgentWorkerEvent): void => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    emitResearch: (event: CompanyResearchWorkerEvent): void => {
      for (const listener of [...researchListeners]) listener(event);
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
