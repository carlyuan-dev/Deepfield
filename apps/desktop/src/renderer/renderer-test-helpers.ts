// @vitest-environment jsdom
import { vi, type Mock } from "vitest";
import type {
  AgentWorkerEvent,
  ChatMessage,
  ConversationId,
  CreateProjectInput,
  DesktopApi,
  MessageId,
  Project,
  ProjectId,
} from "@deepfield/contracts";

export interface FakeDesktopApi extends DesktopApi {
  projects: {
    create: Mock<(input: CreateProjectInput) => Promise<Project>>;
    list: Mock<() => Promise<Project[]>>;
  };
  settings: {
    hasDeepSeekKey: Mock<() => Promise<boolean>>;
    setDeepSeekKey: Mock<(value: string) => Promise<void>>;
  };
  chat: {
    send: Mock<(projectId: string, content: string) => Promise<{ requestId: string }>>;
    subscribe: Mock<(listener: (event: AgentWorkerEvent) => void) => () => void>;
    listMessages: Mock<(projectId: string) => Promise<ChatMessage[]>>;
  };
  listeners: Set<(event: AgentWorkerEvent) => void>;
  emit(event: AgentWorkerEvent): void;
  nextRequestId(): string;
}

let sendSeq = 0;

export function makeFakeApi(): FakeDesktopApi {
  const listeners = new Set<(event: AgentWorkerEvent) => void>();
  const api = {
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
    chat: {
      send: vi.fn(async (_projectId: string, _content: string): Promise<{ requestId: string }> => {
        sendSeq += 1;
        return { requestId: `req-${sendSeq}` };
      }),
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
