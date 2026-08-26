import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import { event, FakeWebContents, makeDeps } from "./ipc-test-helpers.js";

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

  it("requires exactly two arguments for chat.send", async () => {
    const { ipcMain, chat } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1"),
    ).rejects.toThrow(/invalid chat input/);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "p1", "你好", "extra"),
    ).rejects.toThrow(/invalid chat input/);
    expect(chat.sendCalls).toHaveLength(0);
  });
});
