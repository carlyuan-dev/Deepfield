import type {
  AgentWorkerEvent,
  ChatMessage,
  ChatRequestOptions,
  Conversation,
  ConversationId,
  CreateProjectInput,
  Project,
  ProjectId,
  SkillSummary,
} from "@deepfield/contracts";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  registerIpcHandlers,
  type IpcMainLike,
  type IpcServiceDeps,
  type WebContentsLike,
} from "./ipc.js";

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

export class FakeProjectService {
  createCalls: CreateProjectInput[] = [];
  listCalls = 0;

  create(input: CreateProjectInput): Project {
    this.createCalls.push(input);
    return {
      id: "p1" as ProjectId,
      industry: input.industry,
      scope: input.scope,
      status: "draft",
      createdAt: "",
      updatedAt: "",
    };
  }

  list(): Project[] {
    this.listCalls += 1;
    return [];
  }
}

export class FakeConversationService {
  createCalls = 0;
  openInitialCalls = 0;
  listRecentCalls = 0;
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

export class FakeSecretSettings {
  hasCalls: string[] = [];
  setCalls: Array<{ name: string; value: string }> = [];

  has(name: string): boolean {
    this.hasCalls.push(name);
    return true;
  }

  set(name: string, value: string): void {
    this.setCalls.push({ name, value });
  }
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

export function makeDeps() {
  const ipcMain = new FakeIpcMain();
  const conversations = new FakeConversationService();
  const projects = new FakeProjectService();
  const settings = new FakeSecretSettings();
  const skills = new FakeSkillList();
  const chat = new FakeChatService();
  const deps: IpcServiceDeps = { ipcMain, conversations, projects, settings, skills, chat };
  const dispose = registerIpcHandlers(deps);
  return { ipcMain, conversations, projects, settings, skills, chat, dispose };
}

export const event = (sender: WebContentsLike): { sender: WebContentsLike } => ({ sender });

export const workerEvent = (requestId = "req-1"): AgentWorkerEvent => ({
  requestId,
  type: "text_delta",
  delta: "测",
});

export const channels = IPC_CHANNELS;
