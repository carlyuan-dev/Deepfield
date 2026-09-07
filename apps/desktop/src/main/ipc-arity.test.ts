import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  DEFAULT_CHAT_OPTIONS,
  event,
  FakeWebContents,
  makeDeps,
} from "./ipc-test-helpers.js";

describe("ipc handler arity", () => {
  it("requires exactly one argument for projects.create", async () => {
    const { ipcMain, projects } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.projectsCreate, event(sender)),
    ).rejects.toThrow(/invalid project input/);
    await expect(
      ipcMain.invoke(
        IPC_CHANNELS.projectsCreate,
        event(sender),
        { industry: "x", scope: {}, launchSource: "direct-ui" },
        "extra",
      ),
    ).rejects.toThrow(/invalid project input/);
    expect(projects.createCalls).toHaveLength(0);
  });

  it("requires zero arguments for projects.list", async () => {
    const { ipcMain, projects } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.projectsList, event(sender), "extra"),
    ).rejects.toThrow(/invalid list input/);
    expect(projects.listCalls).toBe(0);
    await ipcMain.invoke(IPC_CHANNELS.projectsList, event(sender));
    expect(projects.listCalls).toBe(1);
  });

  it("requires zero arguments for settings.has", async () => {
    const { ipcMain, settings } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.settingsHasDeepSeekKey, event(sender), "extra"),
    ).rejects.toThrow(/invalid settings input/);
    expect(settings.hasCalls).toHaveLength(0);
  });

  it("requires exactly one argument for settings.set", async () => {
    const { ipcMain, settings } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.settingsSetDeepSeekKey, event(sender)),
    ).rejects.toThrow(/invalid settings input/);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.settingsSetDeepSeekKey, event(sender), "a", "b"),
    ).rejects.toThrow(/invalid settings input/);
    expect(settings.setCalls).toHaveLength(0);
  });

  it("requires zero arguments for skills.list", async () => {
    const { ipcMain, skills } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.skillsList, event(sender), "extra"),
    ).rejects.toThrow(/invalid list input/);
    expect(skills.listCalls).toBe(0);
    await ipcMain.invoke(IPC_CHANNELS.skillsList, event(sender));
    expect(skills.listCalls).toBe(1);
  });

  it("requires exactly four arguments and a strict options object for chat.send", async () => {
    const { ipcMain, chat } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "你好"),
    ).rejects.toThrow(/invalid chat input/);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "你好", "req-1"),
    ).rejects.toThrow(/invalid chat input/);
    await expect(
      ipcMain.invoke(
        IPC_CHANNELS.chatSend,
        event(sender),
        "p1",
        "你好",
        "req-1",
        DEFAULT_CHAT_OPTIONS,
        "extra",
      ),
    ).rejects.toThrow(/invalid chat input/);
    await expect(
      ipcMain.invoke(
        IPC_CHANNELS.chatSend,
        event(sender),
        "p1",
        "你好",
        "req-1",
        { skillName: "structured-brief" },
      ),
    ).rejects.toThrow(/invalid chat input/);
    expect(chat.sendCalls).toHaveLength(0);

    await ipcMain.invoke(
      IPC_CHANNELS.chatSend,
      event(sender),
      "p1",
      "你好",
      "req-1",
      DEFAULT_CHAT_OPTIONS,
    );
    expect(chat.sendCalls).toHaveLength(1);
  });

  it("requires exactly one argument for chat.listMessages", async () => {
    const { ipcMain, chat } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatListMessages, event(sender)),
    ).rejects.toThrow(/invalid chat input/);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatListMessages, event(sender), "p1", "extra"),
    ).rejects.toThrow(/invalid chat input/);
    expect(chat.listMessagesCalls).toHaveLength(0);
  });
});
