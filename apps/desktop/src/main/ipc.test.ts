import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { AppError } from "@deepfield/contracts";
import { ResearchRunSchema, ResearchRunSummarySchema, type CompanyResearchBatchState } from "../../../../capabilities/company-research/contracts/index.js";
import type { ConversationId, MessageId } from "@deepfield/contracts";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  channels,
  DEFAULT_CHAT_OPTIONS,
  event,
  FakeWebContents,
  makeDeps,
  RESEARCH_INPUT,
  researchRun,
  workerEvent,
} from "./ipc-test-helpers.js";

const SKILL_OPTIONS = { webSearch: false, skillName: "structured-brief" };
const CONVERSATION_ID = "conv-1";

describe("ipc handlers", () => {
  it("resumes profile queue after real Settings activation, not reads or diagnostics", async () => {
    const { ipcMain, companyProfiles } = makeDeps(); const sender = new FakeWebContents(1);
    await ipcMain.invoke(IPC_CHANNELS.settingsGet, event(sender));
    expect(companyProfiles.configurationChangeCalls).toBe(0);
    await ipcMain.invoke(IPC_CHANNELS.settingsActivateSearchProfile, event(sender), null);
    await ipcMain.invoke(IPC_CHANNELS.settingsActivateLlmProfile, event(sender), null);
    expect(companyProfiles.configurationChangeCalls).toBe(2);
    await expect(ipcMain.invoke(IPC_CHANNELS.settingsActivateSearchProfile, event(sender), 123)).rejects.toThrow();
    expect(companyProfiles.configurationChangeCalls).toBe(2);
  });
  it("writes only the supplied text through the main-process clipboard and propagates errors", async () => {
    const { ipcMain, clipboard } = makeDeps();
    const sender = new FakeWebContents(1);

    await expect(
      ipcMain.invoke(
        IPC_CHANNELS.copyText,
        event(sender),
        "https://actual.example/report%E3%80%82",
      ),
    ).resolves.toBeUndefined();
    expect(clipboard.writeTextCalls).toEqual([
      "https://actual.example/report%E3%80%82",
    ]);

    clipboard.writeError = new Error("clipboard unavailable");
    await expect(
      ipcMain.invoke(IPC_CHANNELS.copyText, event(sender), "https://actual.example/other"),
    ).rejects.toThrow("clipboard unavailable");
  });

  it("validates and delegates conversation deletion", async () => {
    const { ipcMain, conversations } = makeDeps();
    const sender = new FakeWebContents(1);
    await ipcMain.invoke(IPC_CHANNELS.conversationsDelete, event(sender), CONVERSATION_ID);
    expect((conversations as any).deleteCalls).toEqual([CONVERSATION_ID]);
    await expect(ipcMain.invoke(IPC_CHANNELS.conversationsDelete, event(sender), "")).rejects.toThrow();
  });

  it("validates profile drafts and never returns their secret", async () => {
    const { ipcMain, settings } = makeDeps();
    const sender = new FakeWebContents(1);
    const draft = { name: "Test", provider: "custom", protocol: "openai_compatible", baseUrl: "https://llm.test/v1", modelId: "m", contextWindow: 32000, apiKey: "sk-value" } as const;
    const result = await ipcMain.invoke(IPC_CHANNELS.settingsSaveLlmProfile, event(sender), draft);
    expect(result).toEqual(settings.view);
    expect(JSON.stringify(result)).not.toContain("sk-value");
    expect(settings.calls).toEqual([{ method: "saveLlmProfile", value: draft }]);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.settingsSaveLlmProfile, event(sender), { ...draft, baseUrl: "http://unsafe.test" }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.settingsSaveLlmProfile, event(sender), 42),
    ).rejects.toThrow();
    expect(settings.calls).toHaveLength(1);
  });

  it("creates a blank Conversation through the service", async () => {
    const { ipcMain, conversations } = makeDeps();
    const sender = new FakeWebContents(1);

    const created = await ipcMain.invoke(IPC_CHANNELS.conversationsCreate, event(sender));
    expect(created).toMatchObject({ id: "c-created-1", title: "新对话", hasUserMessage: false });
    expect(conversations.createCalls).toBe(1);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.conversationsCreate, event(sender), "extra"),
    ).rejects.toThrow(/invalid conversation input/);
    expect(conversations.createCalls).toBe(1);
  });

  it("opens the initial Conversation with its recent list", async () => {
    const { ipcMain, conversations } = makeDeps();
    const sender = new FakeWebContents(1);
    const active = conversations.makeConversation("conv-1", "整理研究目标", true);
    const recent = [
      active,
      conversations.makeConversation("conv-2", "旧对话", true),
    ];
    conversations.initialActive = active;
    conversations.recent = recent;

    const result = await ipcMain.invoke(IPC_CHANNELS.conversationsOpenInitial, event(sender));
    expect(result).toEqual({ active, recent });
    expect(conversations.openInitialCalls).toBe(1);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.conversationsOpenInitial, event(sender), "extra"),
    ).rejects.toThrow(/invalid conversation input/);
  });

  it("lists recent Conversations and requires zero arguments", async () => {
    const { ipcMain, conversations } = makeDeps();
    const sender = new FakeWebContents(1);
    const recent = [conversations.makeConversation("conv-1", "整理研究目标", true)];
    conversations.recent = recent;

    const result = await ipcMain.invoke(IPC_CHANNELS.conversationsListRecent, event(sender));
    expect(result).toEqual(recent);
    expect(conversations.listRecentCalls).toBe(1);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.conversationsListRecent, event(sender), "extra"),
    ).rejects.toThrow(/invalid conversation input/);
  });

  it("returns only summary metadata from skills.list and requires zero arguments", async () => {
    const { ipcMain, skills } = makeDeps();
    const sender = new FakeWebContents(1);
    const summaries = [
      { name: "structured-brief", description: "Turn a topic or rough notes into a research brief." },
    ];
    skills.summaries = summaries;

    const result = await ipcMain.invoke(IPC_CHANNELS.skillsList, event(sender));
    expect(result).toEqual(summaries);
    expect(skills.listCalls).toBe(1);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.skillsList, event(sender), "extra"),
    ).rejects.toThrow(/invalid list input/);
    expect(skills.listCalls).toBe(1);
  });

  it("validates chat input by Conversation ID and delegates options to the service", async () => {
    const { ipcMain, chat, conversations } = makeDeps();
    const sender = new FakeWebContents(1);
    const result = await ipcMain.invoke(
      IPC_CHANNELS.chatSend,
      event(sender),
      CONVERSATION_ID,
      "你好",
      "req-1",
      SKILL_OPTIONS,
    );
    expect(result).toEqual({
      requestId: "req-1",
      conversation: expect.objectContaining({ id: CONVERSATION_ID, hasUserMessage: true }),
    });
    expect(chat.sendCalls).toEqual([
      {
        conversationId: CONVERSATION_ID,
        content: "你好",
        requestId: "req-1",
        options: SKILL_OPTIONS,
      },
    ]);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), "", "你好", "req-1", SKILL_OPTIONS),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), CONVERSATION_ID, "   ", "req-1", SKILL_OPTIONS),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), CONVERSATION_ID, "你好", "", SKILL_OPTIONS),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.chatSend, event(sender), CONVERSATION_ID, "你好", "req-1", {}),
    ).rejects.toThrow();
    expect(chat.sendCalls).toHaveLength(1);
  });

  it("delegates chat message history for the Conversation", async () => {
    const { ipcMain, chat } = makeDeps();
    const sender = new FakeWebContents(1);
    chat.history = [
      {
        id: "m1" as MessageId,
        conversationId: CONVERSATION_ID as ConversationId,
        role: "user",
        content: "a",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const history = await ipcMain.invoke(
      IPC_CHANNELS.chatListMessages,
      event(sender),
      CONVERSATION_ID,
    );
    expect(chat.listMessagesCalls).toEqual([CONVERSATION_ID]);
    expect(history).toEqual(chat.history);
  });

  it("routes chat events only to the originating renderer", async () => {
    const { ipcMain, chat } = makeDeps();
    const senderA = new FakeWebContents(10);
    const senderB = new FakeWebContents(11);
    await ipcMain.invoke(
      IPC_CHANNELS.chatSend,
      event(senderA),
      CONVERSATION_ID,
      "你好",
      "req-1",
      DEFAULT_CHAT_OPTIONS,
    );
    await ipcMain.invoke(
      IPC_CHANNELS.chatSend,
      event(senderB),
      CONVERSATION_ID,
      "你好",
      "req-2",
      DEFAULT_CHAT_OPTIONS,
    );

    chat.emitToLast(workerEvent("req-2"));
    expect(senderA.sent).toEqual([]);
    expect(senderB.sent).toEqual([
      { channel: channels.chatEvents, payload: workerEvent("req-2") },
    ]);
  });

  it("broadcasts late conversation metadata on its separate channel", async () => {
    const { ipcMain, chat, conversations } = makeDeps();
    const sender = new FakeWebContents(12);
    await ipcMain.invoke(IPC_CHANNELS.conversationsOpenInitial, event(sender));
    const updated = conversations.makeConversation("conv-late", "异步智能标题", true);
    chat.emitConversationUpdate(updated);
    expect(sender.sent).toContainEqual({ channel: IPC_CHANNELS.conversationUpdates, payload: updated });
  });

  it("keeps a single destroyed listener per sender across repeated sends", async () => {
    const { ipcMain } = makeDeps();
    const sender = new FakeWebContents(10);
    await ipcMain.invoke(
      IPC_CHANNELS.chatSend,
      event(sender),
      CONVERSATION_ID,
      "a",
      "req-1",
      DEFAULT_CHAT_OPTIONS,
    );
    await ipcMain.invoke(
      IPC_CHANNELS.chatSend,
      event(sender),
      CONVERSATION_ID,
      "b",
      "req-2",
      DEFAULT_CHAT_OPTIONS,
    );
    expect(sender.destroyedListenerCount).toBe(1);
  });

  it("drops events silently after the sender is destroyed", async () => {
    const { ipcMain, chat } = makeDeps();
    const sender = new FakeWebContents(10);
    await ipcMain.invoke(
      IPC_CHANNELS.chatSend,
      event(sender),
      CONVERSATION_ID,
      "你好",
      "req-1",
      DEFAULT_CHAT_OPTIONS,
    );
    sender.destroy();
    expect(sender.destroyedListenerCount).toBe(0);

    chat.emitToLast(workerEvent());
    expect(sender.sent).toEqual([]);
  });

  it("dispose removes all handlers, listeners and the registry", async () => {
    const { ipcMain, chat, dispose } = makeDeps();
    const sender = new FakeWebContents(10);
    await ipcMain.invoke(
      IPC_CHANNELS.chatSend,
      event(sender),
      CONVERSATION_ID,
      "你好",
      "req-1",
      DEFAULT_CHAT_OPTIONS,
    );
    expect(sender.destroyedListenerCount).toBe(1);

    dispose();
    expect(ipcMain.handlers.size).toBe(0);
    expect(sender.destroyedListenerCount).toBe(0);

    chat.emitToLast(workerEvent());
    expect(sender.sent).toEqual([]);
  });
});
