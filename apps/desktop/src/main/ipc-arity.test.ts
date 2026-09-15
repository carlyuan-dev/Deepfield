import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  DEFAULT_CHAT_OPTIONS,
  event,
  FakeWebContents,
  makeDeps,
  RESEARCH_INPUT,
} from "./ipc-test-helpers.js";

describe("ipc handler arity", () => {
  it.each([
    ["companyResearchStart", "startCalls", ["item-1", "company-1", RESEARCH_INPUT]],
    ["companyResearchCancel", "cancelCalls", ["run-1"]],
    ["companyResearchGetState", "getStateCalls", ["item-1", "company-1"]],
    ["companyResearchListRuns", "listRunsCalls", ["item-1", "company-1"]],
    ["companyResearchGetRun", "getRunCalls", ["item-1", "company-1", "run-1"]],
    ["companyResearchRetryStructuring", "retryStructuringCalls", ["item-1", "company-1", "run-1"]],
  ] as const)("validates exact arity and every field of %s before calling service", async (channel, calls, valid) => {
    const { ipcMain, companyResearch } = makeDeps();
    const sender = new FakeWebContents(1);
    const invalid: unknown[][] = [[], valid.slice(0, -1), [...valid, "extra"]];
    valid.forEach((value, index) => {
      const replacements = typeof value === "string" ? ["", "x".repeat(201), null, 1, {}] : [null, {}, { ...RESEARCH_INPUT, extra: true }, { ...RESEARCH_INPUT, direction: "unknown" }, { ...RESEARCH_INPUT, asOfDate: "today" }, { ...RESEARCH_INPUT, focusScope: "x".repeat(1001) }];
      for (const replacement of replacements) {
        const args: unknown[] = [...valid];
        args[index] = replacement;
        invalid.push(args);
      }
    });
    for (const args of invalid) {
      await expect(ipcMain.invoke(IPC_CHANNELS[channel], event(sender), ...args)).rejects.toThrow("invalid company research input");
    }
    expect(companyResearch[calls]).toHaveLength(0);
    expect(sender.destroyedListenerCount).toBe(0);
    await ipcMain.invoke(IPC_CHANNELS[channel], event(sender), ...valid);
    expect(companyResearch[calls]).toHaveLength(1);
  });

  it("requires zero research subscription arguments before tracking the sender", async () => {
    const { ipcMain } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(ipcMain.invoke(IPC_CHANNELS.companyResearchSubscribe, event(sender), undefined)).rejects.toThrow("invalid company research input");
    expect(sender.destroyedListenerCount).toBe(0);
    await ipcMain.invoke(IPC_CHANNELS.companyResearchSubscribe, event(sender));
    expect(sender.destroyedListenerCount).toBe(1);
  });

  it("requires exactly one argument for industryResearch.createItem", async () => {
    const { ipcMain, industryResearch } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.industryResearchCreateItem, event(sender)),
    ).rejects.toThrow(/invalid research item input/);
    await expect(
      ipcMain.invoke(
        IPC_CHANNELS.industryResearchCreateItem,
        event(sender),
        { industry: "x" },
        "extra",
      ),
    ).rejects.toThrow(/invalid research item input/);
    expect(industryResearch.createItemCalls).toHaveLength(0);
  });

  it("requires zero arguments for industryResearch.listItems", async () => {
    const { ipcMain, industryResearch } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.industryResearchListItems, event(sender), "extra"),
    ).rejects.toThrow(/invalid research item input/);
    expect(industryResearch.listItemsCalls).toBe(0);
    await ipcMain.invoke(IPC_CHANNELS.industryResearchListItems, event(sender));
    expect(industryResearch.listItemsCalls).toBe(1);
  });

  it("requires exactly one non-empty id array for industryResearch.deleteItems", async () => {
    const { ipcMain, industryResearch } = makeDeps();
    const sender = new FakeWebContents(1);
    const channel = IPC_CHANNELS.industryResearchDeleteItems;
    await expect(ipcMain.invoke(channel, event(sender), [])).rejects.toThrow(
      /invalid research item input/,
    );
    await expect(ipcMain.invoke(channel, event(sender), ["item-1", ""])).rejects.toThrow(
      /invalid research item input/,
    );
    await expect(ipcMain.invoke(channel, event(sender), ["item-1"], "extra")).rejects.toThrow(
      /invalid research item input/,
    );
    expect(industryResearch.deleteItemsCalls).toHaveLength(0);
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
});
