import { describe, expect, it } from "vitest";
import type { AgentWorkerEvent, CreateProjectInput, Project, ProjectId } from "@deepfield/contracts";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  registerIpcHandlers,
  type IpcMainLike,
  type IpcServiceDeps,
  type WebContentsLike,
} from "./ipc.js";

class FakeWebContents implements WebContentsLike {
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

class FakeIpcMain implements IpcMainLike {
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

class FakeProjectService {
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

class FakeSecretSettings {
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

class FakeChatService {
  sendCalls: Array<{ projectId: string; content: string }> = [];
  private listeners: Array<(event: AgentWorkerEvent) => void> = [];

  send(projectId: string, content: string, onEvent: (event: AgentWorkerEvent) => void) {
    this.sendCalls.push({ projectId, content });
    this.listeners.push(onEvent);
    return Promise.resolve({ requestId: "req-1" });
  }

  emitToLast(event: AgentWorkerEvent): void {
    this.listeners[this.listeners.length - 1]?.(event);
  }
}

function makeDeps() {
  const ipcMain = new FakeIpcMain();
  const projects = new FakeProjectService();
  const settings = new FakeSecretSettings();
  const chat = new FakeChatService();
  const deps: IpcServiceDeps = { ipcMain, projects, settings, chat };
  const dispose = registerIpcHandlers(deps);
  return { ipcMain, projects, settings, chat, dispose };
}

const event = (sender: WebContentsLike): { sender: WebContentsLike } => ({ sender });

const workerEvent = (requestId = "req-1"): AgentWorkerEvent => ({
  requestId,
  type: "text_delta",
  delta: "测",
});

describe("ipc handlers", () => {
  it("registers exactly the five invoke channels and no chat.events handler", () => {
    const { ipcMain } = makeDeps();
    const registered = [...ipcMain.handlers.keys()].sort();
    expect(registered).toEqual(
      [
        IPC_CHANNELS.projectsCreate,
        IPC_CHANNELS.projectsList,
        IPC_CHANNELS.settingsHasDeepSeekKey,
        IPC_CHANNELS.settingsSetDeepSeekKey,
        IPC_CHANNELS.chatSend,
      ].sort(),
    );
    expect(ipcMain.handlers.has(IPC_CHANNELS.chatEvents)).toBe(false);
  });

  it("validates project input before delegating", async () => {
    const { ipcMain, projects } = makeDeps();
    const sender = new FakeWebContents(1);
    const valid = { industry: "人形机器人", scope: {}, launchSource: "direct-ui" };
    await ipcMain.invoke(IPC_CHANNELS.projectsCreate, event(sender), valid);
    expect(projects.createCalls).toEqual([valid]);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.projectsCreate, event(sender), {
        industry: "   ",
        scope: {},
        launchSource: "direct-ui",
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.projectsCreate, event(sender), {
        industry: "x",
        scope: { focus: 1 },
        launchSource: "direct-ui",
      }),
    ).rejects.toThrow();
    expect(projects.createCalls).toHaveLength(1);
  });

  it("delegates list and key checks without extra business input", async () => {
    const { ipcMain, projects, settings } = makeDeps();
    const sender = new FakeWebContents(1);
    await ipcMain.invoke(IPC_CHANNELS.projectsList, event(sender));
    expect(projects.listCalls).toBe(1);
    const has = await ipcMain.invoke(IPC_CHANNELS.settingsHasDeepSeekKey, event(sender));
    expect(has).toBe(true);
    expect(settings.hasCalls).toEqual(["deepseek.apiKey"]);
  });

  it("requires a non-blank string when setting the key and never returns the secret", async () => {
    const { ipcMain, settings } = makeDeps();
    const sender = new FakeWebContents(1);
    const setResult = await ipcMain.invoke(
      IPC_CHANNELS.settingsSetDeepSeekKey,
      event(sender),
      "sk-value",
    );
    expect(setResult).toBeUndefined();
    expect(settings.setCalls).toEqual([{ name: "deepseek.apiKey", value: "sk-value" }]);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.settingsSetDeepSeekKey, event(sender), "  "),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.settingsSetDeepSeekKey, event(sender), 42),
    ).rejects.toThrow();
    expect(settings.setCalls).toHaveLength(1);
  });

  it("validates chat input and delegates to the service", async () => {
    const { ipcMain, chat } = makeDeps();
    const sender = new FakeWebContents(1);
    const result = await ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "你好");
    expect(result).toEqual({ requestId: "req-1" });
    expect(chat.sendCalls).toEqual([{ projectId: "p1", content: "你好" }]);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "", "你好"),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "   "),
    ).rejects.toThrow();
    expect(chat.sendCalls).toHaveLength(1);
  });

  it("routes chat events only to the originating renderer", async () => {
    const { ipcMain, chat } = makeDeps();
    const senderA = new FakeWebContents(10);
    const senderB = new FakeWebContents(11);
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(senderA), "p1", "你好");
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(senderB), "p1", "你好");

    chat.emitToLast(workerEvent("req-2"));
    expect(senderA.sent).toEqual([]);
    expect(senderB.sent).toEqual([
      { channel: IPC_CHANNELS.chatEvents, payload: workerEvent("req-2") },
    ]);
  });

  it("keeps a single destroyed listener per sender across repeated sends", async () => {
    const { ipcMain } = makeDeps();
    const sender = new FakeWebContents(10);
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "a");
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "b");
    expect(sender.destroyedListenerCount).toBe(1);
  });

  it("drops events silently after the sender is destroyed", async () => {
    const { ipcMain, chat } = makeDeps();
    const sender = new FakeWebContents(10);
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "你好");
    sender.destroy();
    expect(sender.destroyedListenerCount).toBe(0);

    chat.emitToLast(workerEvent());
    expect(sender.sent).toEqual([]);
  });

  it("dispose removes all handlers, listeners and the registry", async () => {
    const { ipcMain, chat, dispose } = makeDeps();
    const sender = new FakeWebContents(10);
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "你好");
    expect(sender.destroyedListenerCount).toBe(1);

    dispose();
    expect(ipcMain.handlers.size).toBe(0);
    expect(sender.destroyedListenerCount).toBe(0);

    chat.emitToLast(workerEvent());
    expect(sender.sent).toEqual([]);
  });
});
