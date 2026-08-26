import type {
  AgentWorkerEvent,
  ChatMessage,
  CreateProjectInput,
  Project,
  ProjectId,
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

export class FakeChatService {
  sendCalls: Array<{ projectId: string; content: string }> = [];
  listMessagesCalls: string[] = [];
  history: ChatMessage[] = [];
  private listeners: Array<(event: AgentWorkerEvent) => void> = [];

  send(projectId: string, content: string, onEvent: (event: AgentWorkerEvent) => void) {
    this.sendCalls.push({ projectId, content });
    this.listeners.push(onEvent);
    return Promise.resolve({ requestId: "req-1" });
  }

  listMessages(projectId: string): ChatMessage[] {
    this.listMessagesCalls.push(projectId);
    return this.history;
  }

  emitToLast(event: AgentWorkerEvent): void {
    this.listeners[this.listeners.length - 1]?.(event);
  }
}

export function makeDeps() {
  const ipcMain = new FakeIpcMain();
  const projects = new FakeProjectService();
  const settings = new FakeSecretSettings();
  const chat = new FakeChatService();
  const deps: IpcServiceDeps = { ipcMain, projects, settings, chat };
  const dispose = registerIpcHandlers(deps);
  return { ipcMain, projects, settings, chat, dispose };
}

export const event = (sender: WebContentsLike): { sender: WebContentsLike } => ({ sender });

export const workerEvent = (requestId = "req-1"): AgentWorkerEvent => ({
  requestId,
  type: "text_delta",
  delta: "测",
});

export const channels = IPC_CHANNELS;
