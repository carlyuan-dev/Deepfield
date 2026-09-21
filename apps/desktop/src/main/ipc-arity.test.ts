import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  DEFAULT_CHAT_OPTIONS,
  event,
  FakeWebContents,
  makeDeps,
  RESEARCH_INPUT,
} from "./ipc-test-helpers.js";

describe("generic IPC arity", () => {
  it("validates the dedicated conversation web search setting", async () => {
    const { ipcMain } = makeDeps();
    const sender = new FakeWebContents(1);
    for (const args of [[], ["c1"], ["", true], ["c1", "true"], ["c1", true, "extra"]]) {
      await expect(ipcMain.invoke(IPC_CHANNELS.conversationsSetWebSearchEnabled, event(sender), ...args)).rejects.toThrow("invalid conversation input");
    }
    await expect(ipcMain.invoke(IPC_CHANNELS.conversationsSetWebSearchEnabled, event(sender), "c1", true)).resolves.toMatchObject({ id: "c1", webSearchEnabled: true });
  });

  it("requires zero arguments for settings.get", async () => {
    const { ipcMain, settings } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.settingsGet, event(sender), "extra"),
    ).rejects.toThrow(/invalid settings input/);
    expect(settings.calls).toHaveLength(0);
  });

  it("requires exactly one valid argument for profile saves", async () => {
    const { ipcMain, settings } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.settingsSaveLlmProfile, event(sender)),
    ).rejects.toThrow(/invalid settings input/);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.settingsSaveLlmProfile, event(sender), "a", "b"),
    ).rejects.toThrow(/invalid settings input/);
    expect(settings.calls).toHaveLength(0);
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

  it("requires exactly one string for copyText", async () => {
    const { ipcMain, clipboard } = makeDeps();
    const sender = new FakeWebContents(1);

    for (const args of [[], [null], [42], [{}], [["text"]], ["text", "extra"]]) {
      await expect(
        ipcMain.invoke(IPC_CHANNELS.copyText, event(sender), ...args),
      ).rejects.toThrow(/invalid clipboard input/);
    }
    expect(clipboard.writeTextCalls).toEqual([]);

    await ipcMain.invoke(IPC_CHANNELS.copyText, event(sender), "plain text");
    expect(clipboard.writeTextCalls).toEqual(["plain text"]);
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
  it("rejects extra capability arguments before package lookup", async () => {
    const { ipcMain, dispose } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(ipcMain.invoke(IPC_CHANNELS.capabilityInvoke, event(sender), { capabilityId: "company-research", operation: "companyResearch.cancel", requestId: "r", input: ["run-1"] }, "extra")).resolves.toMatchObject({ ok: false, error: { code: "INPUT.INVALID" } });
    expect(sender.destroyedListenerCount).toBe(0);
    dispose();
  });
});
