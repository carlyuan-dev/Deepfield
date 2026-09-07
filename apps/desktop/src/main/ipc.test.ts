import { describe, expect, it } from "vitest";
import type { ConversationId, MessageId } from "@deepfield/contracts";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  channels,
  DEFAULT_CHAT_OPTIONS,
  event,
  FakeWebContents,
  makeDeps,
  workerEvent,
} from "./ipc-test-helpers.js";

const SKILL_OPTIONS = { webSearch: false, skillName: "structured-brief" };
const CONVERSATION_ID = "conv-1";

describe("ipc handlers", () => {
  it("registers exactly the ten invoke channels and no chat.events handler", () => {
    const { ipcMain } = makeDeps();
    const registered = [...ipcMain.handlers.keys()].sort();
    expect(registered).toEqual(
      [
        IPC_CHANNELS.projectsCreate,
        IPC_CHANNELS.projectsList,
        IPC_CHANNELS.conversationsCreate,
        IPC_CHANNELS.conversationsOpenInitial,
        IPC_CHANNELS.conversationsListRecent,
        IPC_CHANNELS.settingsHasDeepSeekKey,
        IPC_CHANNELS.settingsSetDeepSeekKey,
        IPC_CHANNELS.skillsList,
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
    const { ipcMain, chat } = makeDeps();
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
