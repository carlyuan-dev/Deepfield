import { describe, expect, it } from "vitest";
import type { ConversationId, MessageId } from "@deepfield/contracts";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  channels,
  event,
  FakeWebContents,
  makeDeps,
  workerEvent,
} from "./ipc-test-helpers.js";

describe("ipc handlers", () => {
  it("registers exactly the six invoke channels and no chat.events handler", () => {
    const { ipcMain } = makeDeps();
    const registered = [...ipcMain.handlers.keys()].sort();
    expect(registered).toEqual(
      [
        IPC_CHANNELS.projectsCreate,
        IPC_CHANNELS.projectsList,
        IPC_CHANNELS.settingsHasDeepSeekKey,
        IPC_CHANNELS.settingsSetDeepSeekKey,
        IPC_CHANNELS.chatSend,
        IPC_CHANNELS.chatListMessages,
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
    const result = await ipcMain.invoke(
      IPC_CHANNELS.chatSend,
      event(sender),
      "p1",
      "你好",
      "req-1",
    );
    expect(result).toEqual({ requestId: "req-1" });
    expect(chat.sendCalls).toEqual([{ projectId: "p1", content: "你好", requestId: "req-1" }]);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "", "你好", "req-1"),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "   ", "req-1"),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "你好", ""),
    ).rejects.toThrow();
    expect(chat.sendCalls).toHaveLength(1);
  });

  it("delegates chat message history for the project", async () => {
    const { ipcMain, chat } = makeDeps();
    const sender = new FakeWebContents(1);
    chat.history = [
      {
        id: "m1" as MessageId,
        conversationId: "c1" as ConversationId,
        role: "user",
        content: "a",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const history = await ipcMain.invoke(IPC_CHANNELS.chatListMessages, event(sender), "p1");
    expect(chat.listMessagesCalls).toEqual(["p1"]);
    expect(history).toEqual(chat.history);
  });

  it("routes chat events only to the originating renderer", async () => {
    const { ipcMain, chat } = makeDeps();
    const senderA = new FakeWebContents(10);
    const senderB = new FakeWebContents(11);
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(senderA), "p1", "你好", "req-1");
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(senderB), "p1", "你好", "req-2");

    chat.emitToLast(workerEvent("req-2"));
    expect(senderA.sent).toEqual([]);
    expect(senderB.sent).toEqual([
      { channel: channels.chatEvents, payload: workerEvent("req-2") },
    ]);
  });

  it("keeps a single destroyed listener per sender across repeated sends", async () => {
    const { ipcMain } = makeDeps();
    const sender = new FakeWebContents(10);
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "a", "req-1");
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "b", "req-2");
    expect(sender.destroyedListenerCount).toBe(1);
  });

  it("drops events silently after the sender is destroyed", async () => {
    const { ipcMain, chat } = makeDeps();
    const sender = new FakeWebContents(10);
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "你好", "req-1");
    sender.destroy();
    expect(sender.destroyedListenerCount).toBe(0);

    chat.emitToLast(workerEvent());
    expect(sender.sent).toEqual([]);
  });

  it("dispose removes all handlers, listeners and the registry", async () => {
    const { ipcMain, chat, dispose } = makeDeps();
    const sender = new FakeWebContents(10);
    await ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "你好", "req-1");
    expect(sender.destroyedListenerCount).toBe(1);

    dispose();
    expect(ipcMain.handlers.size).toBe(0);
    expect(sender.destroyedListenerCount).toBe(0);

    chat.emitToLast(workerEvent());
    expect(sender.sent).toEqual([]);
  });
});
