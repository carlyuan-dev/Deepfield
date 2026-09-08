// @vitest-environment jsdom
import { vi, type Mock } from "vitest";
import type {
  AgentWorkerEvent,
  ChatMessage,
  ChatRequestOptions,
  ChatSendResult,
  Conversation,
  ConversationId,
  CreateProjectInput,
  DesktopApi,
  MessageId,
  Project,
  ProjectId,
  SkillSummary,
  LlmConnectionStatus,
} from "@deepfield/contracts";

export interface FakeDesktopApi extends DesktopApi {
  conversations: {
    create: Mock<() => Promise<Conversation>>;
    openInitial: Mock<() => Promise<{ active: Conversation; recent: Conversation[] }>>;
    listRecent: Mock<() => Promise<Conversation[]>>;
  };
  projects: {
    create: Mock<(input: CreateProjectInput) => Promise<Project>>;
    list: Mock<() => Promise<Project[]>>;
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
  emit(event: AgentWorkerEvent): void;
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
    projects: {
      create: vi.fn(async (input: CreateProjectInput): Promise<Project> => ({
        id: `p-${++sendSeq}` as ProjectId,
        industry: input.industry,
        scope: input.scope,
        status: "draft",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      list: vi.fn(async (): Promise<Project[]> => []),
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
    emit: (event: AgentWorkerEvent): void => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    nextRequestId: (): string => `req-${++sendSeq}`,
  };
  return api as unknown as FakeDesktopApi;
}

export function project(overrides: { id?: string } & Partial<Omit<Project, "id">> = {}): Project {
  const { id, ...rest } = overrides;
  return {
    id: (id ?? "p1") as ProjectId,
    industry: "人形机器人",
    scope: {},
    status: "draft",
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
