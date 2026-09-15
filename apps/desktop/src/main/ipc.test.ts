import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import { ResearchRunSchema, ResearchRunSummarySchema } from "@deepfield/contracts";
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
  it("registers the fixed invoke channels and no chat.events handler", () => {
    const { ipcMain } = makeDeps();
    const registered = [...ipcMain.handlers.keys()].sort();
    expect(registered).toEqual(
      [
        IPC_CHANNELS.industryResearchCreateItem,
        IPC_CHANNELS.industryResearchUpdateItem,
        IPC_CHANNELS.industryResearchDeleteItem,
        IPC_CHANNELS.industryResearchDeleteItems,
        IPC_CHANNELS.industryResearchListItems,
        IPC_CHANNELS.industryResearchGetItem,
        IPC_CHANNELS.industryResearchListCompanies,
        IPC_CHANNELS.industryResearchUpdateCompany,
        IPC_CHANNELS.industryResearchAddCompany,
        IPC_CHANNELS.industryResearchAddCompanies,
        IPC_CHANNELS.industryResearchRemoveCompany,
        IPC_CHANNELS.industryResearchRemoveCompanies,
        IPC_CHANNELS.industryResearchRecognizeCompanies,
        IPC_CHANNELS.industryResearchRetryCompanyProfile,
        IPC_CHANNELS.industryResearchSubscribeCompanyProfiles,
        IPC_CHANNELS.companyResearchStart,
        IPC_CHANNELS.companyResearchCancel,
        IPC_CHANNELS.companyResearchGetState,
        IPC_CHANNELS.companyResearchListRuns,
        IPC_CHANNELS.companyResearchGetRun,
        IPC_CHANNELS.companyResearchRetryStructuring,
        IPC_CHANNELS.companyResearchSubscribe,
        IPC_CHANNELS.conversationsCreate,
        IPC_CHANNELS.conversationsDelete,
        IPC_CHANNELS.conversationsOpenInitial,
        IPC_CHANNELS.conversationsListRecent,
        IPC_CHANNELS.settingsGet, IPC_CHANNELS.settingsSaveLlmProfile, IPC_CHANNELS.settingsActivateLlmProfile, IPC_CHANNELS.settingsDeleteLlmProfile, IPC_CHANNELS.settingsDiagnoseLlm,
        IPC_CHANNELS.settingsSaveSearchProfile, IPC_CHANNELS.settingsActivateSearchProfile, IPC_CHANNELS.settingsDeleteSearchProfile, IPC_CHANNELS.settingsDiagnoseSearch,
        IPC_CHANNELS.skillsList,
        IPC_CHANNELS.copyText,
        IPC_CHANNELS.chatSend,
        IPC_CHANNELS.chatListMessages,
      ].sort(),
    );
    expect(ipcMain.handlers.has(IPC_CHANNELS.chatEvents)).toBe(false);
    expect(ipcMain.handlers.has(IPC_CHANNELS.companyResearchEvents)).toBe(false);
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

  it("validates research item input before delegating", async () => {
    const { ipcMain, industryResearch } = makeDeps();
    const sender = new FakeWebContents(1);
    const valid = { industry: "人形机器人", researchScope: "整机" };
    await ipcMain.invoke(IPC_CHANNELS.industryResearchCreateItem, event(sender), valid);
    expect(industryResearch.createItemCalls).toEqual([valid]);

    await expect(
      ipcMain.invoke(IPC_CHANNELS.industryResearchCreateItem, event(sender), {
        industry: "   ",
      }),
    ).rejects.toThrow();
    await expect(
      ipcMain.invoke(IPC_CHANNELS.industryResearchCreateItem, event(sender), {
        industry: "x",
        extra: true,
      }),
    ).rejects.toThrow();
    expect(industryResearch.createItemCalls).toHaveLength(1);
  });

  it("validates and delegates item mutations and batch membership removal", async () => {
    const { ipcMain, industryResearch } = makeDeps();
    const sender = new FakeWebContents(1);
    const update = { industry: "具身智能", researchScope: "中国" };

    await ipcMain.invoke(IPC_CHANNELS.industryResearchUpdateItem, event(sender), "item-1", update);
    await ipcMain.invoke(IPC_CHANNELS.industryResearchRemoveCompanies, event(sender), "item-1", [
      "company-1",
      "company-1",
      "company-2",
    ]);
    await ipcMain.invoke(IPC_CHANNELS.industryResearchDeleteItem, event(sender), "item-1");
    await ipcMain.invoke(IPC_CHANNELS.industryResearchDeleteItems, event(sender), ["item-1", "item-2"]);
    const profile = { name: "ACME", aliases: [], officialWebsite: null, stockListings: [] };
    await ipcMain.invoke(
      IPC_CHANNELS.industryResearchUpdateCompany,
      event(sender),
      "company-1",
      profile,
    );
    await ipcMain.invoke(
      IPC_CHANNELS.industryResearchRetryCompanyProfile,
      event(sender),
      "company-1",
    );

    expect(industryResearch.updateItemCalls).toEqual([{ itemId: "item-1", input: update }]);
    expect(industryResearch.removeCompaniesCalls).toEqual([
      { itemId: "item-1", companyIds: ["company-1", "company-1", "company-2"] },
    ]);
    expect(industryResearch.deleteItemCalls).toEqual(["item-1"]);
    expect(industryResearch.deleteItemsCalls).toEqual([["item-1", "item-2"]]);
    expect(industryResearch.updateCompanyCalls).toEqual([{ companyId: "company-1", input: profile }]);
    expect(industryResearch.retryCompanyProfileCalls).toEqual(["company-1"]);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.industryResearchUpdateItem, event(sender), "item-1", {
        industry: "  ",
      }),
    ).rejects.toThrow(/invalid research item input/);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.industryResearchRemoveCompanies, event(sender), "item-1", [""]),
    ).rejects.toThrow(/invalid company input/);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.industryResearchUpdateCompany, event(sender), "company-1", {
        name: "ACME",
        businessTags: [],
      }),
    ).rejects.toThrow(/invalid company profile/);
    await expect(
      ipcMain.invoke(IPC_CHANNELS.industryResearchAddCompany, event(sender), "item-1", {
        name: "x".repeat(301),
      }),
    ).rejects.toThrow(/invalid company input/);
    expect(industryResearch.addCompanyCalls).toHaveLength(0);
  });

  it("delegates list, research lifecycle, and settings reads with strict arguments", async () => {
    const { ipcMain, industryResearch, companyResearch, companyProfiles, settings } = makeDeps();
    const sender = new FakeWebContents(1);
    await ipcMain.invoke(IPC_CHANNELS.industryResearchListItems, event(sender));
    expect(industryResearch.listItemsCalls).toBe(1);
    const view = await ipcMain.invoke(IPC_CHANNELS.settingsGet, event(sender));
    expect(view).toEqual(settings.view);
    expect(settings.calls).toEqual([{ method: "get" }]);
    const started = await ipcMain.invoke(
      IPC_CHANNELS.companyResearchStart,
      event(sender),
      "item-1",
      "company-1",
      RESEARCH_INPUT,
    );
    await ipcMain.invoke(IPC_CHANNELS.companyResearchGetState, event(sender), "item-1", "company-1");
    await ipcMain.invoke(IPC_CHANNELS.companyResearchListRuns, event(sender), "item-1", "company-1");
    await ipcMain.invoke(IPC_CHANNELS.companyResearchCancel, event(sender), "run-1");
    expect(started).toMatchObject({ id: "run-1", status: "researching", schemaVersion: "company-research-report-v1" });
    expect(Value.Check(ResearchRunSchema, started)).toBe(true);
    expect(companyResearch.startCalls).toEqual([
      { itemId: "item-1", companyId: "company-1", input: RESEARCH_INPUT },
    ]);
    await expect(
      ipcMain.invoke(
        IPC_CHANNELS.companyResearchStart,
        event(sender),
        "item-1",
        "company-1",
        { timeScope: " ", extra: true },
      ),
    ).rejects.toThrow(/invalid company research input/);

    const researchEvent = { itemId: "item-1", companyId: "company-1", runId: "run-1", type: "state_changed" } as const;
    companyResearch.emit(researchEvent);
    expect(sender.sent).toContainEqual({
      channel: IPC_CHANNELS.companyResearchEvents,
      payload: researchEvent,
    });
    await ipcMain.invoke(IPC_CHANNELS.industryResearchSubscribeCompanyProfiles, event(sender));
    const profileEvent = { companyId: "company-1", status: "ready" } as const;
    companyProfiles.emit(profileEvent);
    expect(sender.sent).toContainEqual({
      channel: IPC_CHANNELS.industryResearchCompanyProfileEvents,
      payload: profileEvent,
    });
  });

  it("reads versioned details, missing runs and summary history, and retries the exact target", async () => {
    const { ipcMain, companyResearch } = makeDeps();
    const sender = new FakeWebContents(1);
    const target = ["item-1", "company-1", "run-1"];
    const run = researchRun({ status: "structure_failed", rawReportText: "# Saved raw report", structuringAttempts: 1, lastFailureCode: "structuring_failed" });
    companyResearch.run = run;
    const { rawReportText, researchContext, template, harnessVersion, structuredContent, ...summary } = run;
    companyResearch.runs = [{ ...summary, status: "structure_failed" }];
    expect(Value.Check(ResearchRunSchema, run)).toBe(true);
    expect(Value.Check(ResearchRunSummarySchema, companyResearch.runs[0])).toBe(true);
    await expect(ipcMain.invoke(IPC_CHANNELS.companyResearchGetRun, event(sender), ...target)).resolves.toEqual(run);
    await expect(ipcMain.invoke(IPC_CHANNELS.companyResearchGetRun, event(sender), "item-1", "company-1", "missing")).resolves.toBeUndefined();
    await expect(ipcMain.invoke(IPC_CHANNELS.companyResearchListRuns, event(sender), "item-1", "company-1")).resolves.toEqual([summary]);
    await expect(ipcMain.invoke(IPC_CHANNELS.companyResearchGetState, event(sender), "item-1", "company-1")).resolves.toEqual({ runs: [summary], globalActiveRun: null });
    await expect(ipcMain.invoke(IPC_CHANNELS.companyResearchRetryStructuring, event(sender), ...target)).resolves.toMatchObject({ status: "structuring", rawReportText: "# Saved raw report", structuringAttempts: 2 });
    expect(companyResearch.getRunCalls[0]).toEqual({ itemId: "item-1", companyId: "company-1", runId: "run-1" });
    expect(companyResearch.listRunsCalls).toEqual([{ itemId: "item-1", companyId: "company-1" }]);
    expect(companyResearch.retryStructuringCalls).toEqual([{ itemId: "item-1", companyId: "company-1", runId: "run-1" }]);
  });

  it.each(["other-item", "other-company"])("safely rejects a run owned by %s without report JSON", async (wrongTarget) => {
    const { ipcMain, companyResearch } = makeDeps();
    companyResearch.run = researchRun({ rawReportText: "private report JSON" });
    const args = wrongTarget === "other-item" ? [wrongTarget, "company-1", "run-1"] : ["item-1", wrongTarget, "run-1"];
    const error = await ipcMain.invoke(IPC_CHANNELS.companyResearchGetRun, event(new FakeWebContents(1)), ...args).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("company research read failed");
    expect(String(error)).not.toContain("private report JSON");
  });

  it.each([
    ["start", "companyResearchStart", ["item-1", "company-1", RESEARCH_INPUT], "start"],
    ["cancel", "companyResearchCancel", ["run-1"], "cancellation"],
    ["getState", "companyResearchGetState", ["item-1", "company-1"], "read"],
    ["listRuns", "companyResearchListRuns", ["item-1", "company-1"], "read"],
    ["getRun", "companyResearchGetRun", ["item-1", "company-1", "run-1"], "read"],
    ["retryStructuring", "companyResearchRetryStructuring", ["item-1", "company-1", "run-1"], "structuring retry"],
  ] as const)("sanitizes %s service errors", async (method, channel, args, action) => {
    const { ipcMain, companyResearch } = makeDeps();
    vi.spyOn(companyResearch, method).mockImplementation(() => { throw new Error('sk-secret provider error {"candidate":true}'); });
    const error = await ipcMain.invoke(IPC_CHANNELS[channel], event(new FakeWebContents(1)), ...args).catch((error: Error) => error);
    expect((error as Error).message).toBe(`company research ${action} failed`);
  });

  it("broadcasts only public research events and cleans up subscriptions", async () => {
    const { ipcMain, companyResearch, dispose } = makeDeps();
    const a = new FakeWebContents(1);
    const b = new FakeWebContents(2);
    const untracked = new FakeWebContents(3);
    for (const sender of [a, a, b]) await ipcMain.invoke(IPC_CHANNELS.companyResearchSubscribe, event(sender));
    const changed = { type: "state_changed", itemId: "item-1", companyId: "company-1", runId: "run-1" };
    const delta = { type: "text_delta", stage: "raw", requestId: "r", runId: "run-1", delta: "raw Markdown" };
    const worker = { requestId: "r", runId: "run-1", stage: "structure" };
    for (const invalid of [
      { ...worker, type: "started" }, { ...worker, type: "completed", text: '{"unvalidated":true}' },
      { ...worker, stage: "raw", type: "completed", text: "raw report" },
      { ...worker, type: "failed", code: "structuring_failed", message: "company research structuring failed" },
      { ...worker, type: "cancelled" }, { ...delta, stage: "structure" },
      { ...changed, apiKey: "sk-secret" }, { ...changed, companyId: undefined }, { ...delta, delta: 1 },
    ]) companyResearch.emit(invalid);
    expect(a.sent).toEqual([]);
    companyResearch.emit(changed);
    companyResearch.emit(delta);
    expect(a.sent).toEqual([changed, delta].map((payload) => ({ channel: IPC_CHANNELS.companyResearchEvents, payload })));
    expect(b.sent).toEqual(a.sent);
    expect(untracked.sent).toEqual([]);
    expect(a.destroyedListenerCount).toBe(1);
    a.destroy();
    companyResearch.emit(changed);
    expect(a.sent).toHaveLength(2);
    expect(b.sent).toHaveLength(3);
    dispose();
    companyResearch.emit(changed);
    expect(b.sent).toHaveLength(3);
    expect(b.destroyedListenerCount).toBe(0);
  });

  it("forwards only the safe transient outcomes on public state changes", async () => {
    const { ipcMain, companyResearch } = makeDeps();
    const sender = new FakeWebContents(1);
    await ipcMain.invoke(IPC_CHANNELS.companyResearchSubscribe, event(sender));
    const changed = { type: "state_changed", itemId: "item-1", companyId: "company-1", runId: "run-1" };
    const failed = { ...changed, outcome: "research_failed" };
    const cancelled = { ...changed, outcome: "cancelled" };
    companyResearch.emit(failed);
    companyResearch.emit(cancelled);
    companyResearch.emit({ ...changed, outcome: "provider-error sk-secret" });
    companyResearch.emit({ ...changed, outcome: "research_failed", message: "provider secret" });
    companyResearch.emit({ requestId: "rr", runId: "run-1", stage: "raw", type: "failed", code: "research_failed", message: "company research failed" });
    expect(sender.sent).toEqual([
      { channel: IPC_CHANNELS.companyResearchEvents, payload: failed },
      { channel: IPC_CHANNELS.companyResearchEvents, payload: cancelled },
    ]);
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
