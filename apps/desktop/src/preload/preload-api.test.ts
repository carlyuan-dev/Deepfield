import { describe, expect, it } from "vitest";
import {
  createPreloadApi,
  IPC_CHANNELS,
  type IpcBridge,
} from "./preload-api.js";
import type {
  AgentWorkerEvent,
  ChatRequestOptions,
  CompanyResearchEvent,
  CompanyProfileEvent,
  DesktopApi,
} from "@deepfield/contracts";

const CHAT_OPTIONS: ChatRequestOptions = { webSearch: false, skillName: "structured-brief" };

interface FakeIpc {
  ipc: IpcBridge;
  invokes: Array<{ channel: string; args: unknown[] }>;
  listeners: Map<string, Set<(event: unknown, ...args: unknown[]) => void>>;
}

function makeFakeIpc(): FakeIpc {
  const invokes: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, Set<(event: unknown, ...args: unknown[]) => void>>();
  const ipc: IpcBridge = {
    invoke: async (channel, ...args) => {
      invokes.push({ channel, args });
      return undefined;
    },
    on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => {
        set.delete(listener);
      };
    },
  };
  return { ipc, invokes, listeners };
}

describe("preload api", () => {
  it("forwards safe transient state outcomes without admitting Worker failures", () => {
    const { ipc, listeners } = makeFakeIpc();
    const api = createPreloadApi(ipc);
    const received: CompanyResearchEvent[] = [];
    api.companyResearch.subscribe((event) => received.push(event));
    const changed = { type: "state_changed", itemId: "item-1", companyId: "company-1", runId: "run-1" };
    const failed = { ...changed, outcome: "research_failed" };
    const cancelled = { ...changed, outcome: "cancelled" };
    for (const listener of listeners.get(IPC_CHANNELS.companyResearchEvents) ?? []) {
      listener({}, failed);
      listener({}, cancelled);
      listener({}, { ...changed, outcome: "provider-error sk-secret" });
      listener({}, { ...changed, outcome: "research_failed", message: "provider secret" });
      listener({}, { requestId: "rr", runId: "run-1", stage: "raw", type: "failed", code: "research_failed", message: "company research failed" });
    }
    expect(received).toEqual([failed, cancelled]);
  });

  it("exposes only the DesktopApi shape without ipcRenderer or secrets", () => {
    const { ipc } = makeFakeIpc();
    const api: DesktopApi = createPreloadApi(ipc);
    expect(Object.keys(api).sort()).toEqual([
      "chat",
      "companyResearch",
      "conversations",
      "copyText",
      "industryResearch",
      "settings",
      "skills",
    ]);
    expect(Object.keys(api.conversations).sort()).toEqual(["create", "delete", "listRecent", "openInitial"]);
    expect(Object.keys(api.industryResearch).sort()).toEqual([
      "addCompanies",
      "addCompany",
      "createItem",
      "deleteItem",
      "deleteItems",
      "getItem",
      "listCompanies",
      "listItems",
      "recognizeCompanies",
      "removeCompanies",
      "removeCompany",
      "retryCompanyProfile",
      "subscribeCompanyProfiles",
      "updateCompany",
      "updateItem",
    ]);
    expect(Object.keys(api.settings).sort()).toEqual(["activateLlmProfile", "activateSearchProfile", "deleteLlmProfile", "deleteSearchProfile", "diagnoseLlm", "diagnoseSearch", "get", "saveLlmProfile", "saveSearchProfile"]);
    expect(Object.keys(api.skills).sort()).toEqual(["list"]);
    expect(Object.keys(api.chat).sort()).toEqual(["listMessages", "send", "subscribe"]);
    expect(Object.keys(api.companyResearch).sort()).toEqual([
      "cancel",
      "deleteRun",
      "getRun",
      "getState",
      "listRuns",
      "retryFailed",
      "start",
      "subscribe",
    ]);
    expect(JSON.stringify(api)).not.toContain("ipcRenderer");
    expect(JSON.stringify(api)).not.toContain("apiKey");
    expect(JSON.stringify(api)).not.toContain("deepseek");
  });

  it("exposes one narrow text-copy method on a fixed IPC channel", async () => {
    const { ipc, invokes } = makeFakeIpc();
    const api = createPreloadApi(ipc);

    await api.copyText("https://actual.example/report%E3%80%82");

    expect(invokes).toEqual([
      {
        channel: IPC_CHANNELS.copyText,
        args: ["https://actual.example/report%E3%80%82"],
      },
    ]);
    expect(Reflect.has(api, "clipboard")).toBe(false);
    expect(Reflect.has(api, "ipcRenderer")).toBe(false);
  });

  it("propagates copy failures to the renderer", async () => {
    const denied = new Error("clipboard write denied");
    const { ipc: baseIpc } = makeFakeIpc();
    const api = createPreloadApi({
      ...baseIpc,
      invoke: async () => Promise.reject(denied),
    });

    await expect(api.copyText("https://actual.example/report")).rejects.toBe(denied);
  });

  it("forwards conversation deletion through its fixed channel", async () => {
    const { ipc, invokes } = makeFakeIpc();
    const api = createPreloadApi(ipc);
    await (api.conversations as any).delete("conversation-1");
    expect(invokes).toContainEqual({ channel: IPC_CHANNELS.conversationsDelete, args: ["conversation-1"] });
  });

  it("maps method calls to fixed channels", async () => {
    const { ipc, invokes } = makeFakeIpc();
    const api = createPreloadApi(ipc);
    const input = { industry: "人形机器人", researchScope: "整机" };
    await api.industryResearch.createItem(input);
    await api.industryResearch.updateItem("item-1", { industry: "具身智能" });
    await api.industryResearch.deleteItem("item-1");
    const deleteItems = Reflect.get(api.industryResearch, "deleteItems") as
      | ((itemIds: string[]) => Promise<void>)
      | undefined;
    expect(deleteItems).toBeTypeOf("function");
    await deleteItems!(["item-1", "item-2"]);
    await api.industryResearch.listItems();
    await api.industryResearch.getItem("item-1");
    await api.industryResearch.listCompanies("item-1");
    await api.industryResearch.updateCompany("company-1", { name: "公司甲", aliases: [] });
    await api.industryResearch.addCompany("item-1", { name: "公司甲" });
    await api.industryResearch.addCompanies("item-1", [{ name: "公司乙" }]);
    await api.industryResearch.removeCompany("item-1", "company-1");
    await api.industryResearch.removeCompanies("item-1", ["company-1", "company-2"]);
    await api.industryResearch.recognizeCompanies("item-1", "公司甲");
    await api.industryResearch.retryCompanyProfile("company-1");
    api.industryResearch.subscribeCompanyProfiles(() => {});
    await api.companyResearch.start("item-1", "company-1", { direction: "product_and_technology", asOfDate: "2026-09-11" });
    await api.companyResearch.cancel("run-1");
    await api.companyResearch.getState("item-1", "company-1");
    await api.companyResearch.listRuns("item-1", "company-1");
    await api.companyResearch.getRun("item-1", "company-1", "run-1");
    const retryInput = { direction: "product_and_technology", focusScope: "整机", asOfDate: "2026-09-11" } as const;
    await api.companyResearch.retryFailed("item-1", "company-1", "run-1", retryInput);
    await api.companyResearch.deleteRun("item-1", "company-1", "run-1");
    const llmDraft = { name: "Test", provider: "custom", protocol: "openai_compatible", baseUrl: "https://llm.test/v1", modelId: "m", contextWindow: 32000 } as const;
    const searchDraft = { name: "Search", provider: "zhipu", baseUrl: "https://search.test/v4", options: {} } as const;
    await api.settings.get();
    await api.settings.saveLlmProfile(llmDraft); await api.settings.activateLlmProfile("l1"); await api.settings.deleteLlmProfile("l1"); await api.settings.diagnoseLlm(llmDraft);
    await api.settings.saveSearchProfile(searchDraft); await api.settings.activateSearchProfile("s1"); await api.settings.deleteSearchProfile("s1"); await api.settings.diagnoseSearch(searchDraft);
    await api.conversations.create();
    await api.conversations.openInitial();
    await api.conversations.listRecent();
    await api.skills.list();
    await api.chat.send("conv-1", "你好", "req-1", CHAT_OPTIONS);
    await api.chat.listMessages("conv-1");
    expect(invokes).toEqual([
      { channel: IPC_CHANNELS.industryResearchCreateItem, args: [input] },
      { channel: IPC_CHANNELS.industryResearchUpdateItem, args: ["item-1", { industry: "具身智能" }] },
      { channel: IPC_CHANNELS.industryResearchDeleteItem, args: ["item-1"] },
      { channel: IPC_CHANNELS.industryResearchDeleteItems, args: [["item-1", "item-2"]] },
      { channel: IPC_CHANNELS.industryResearchListItems, args: [] },
      { channel: IPC_CHANNELS.industryResearchGetItem, args: ["item-1"] },
      { channel: IPC_CHANNELS.industryResearchListCompanies, args: ["item-1"] },
      { channel: IPC_CHANNELS.industryResearchUpdateCompany, args: ["company-1", { name: "公司甲", aliases: [] }] },
      { channel: IPC_CHANNELS.industryResearchAddCompany, args: ["item-1", { name: "公司甲" }] },
      { channel: IPC_CHANNELS.industryResearchAddCompanies, args: ["item-1", [{ name: "公司乙" }]] },
      { channel: IPC_CHANNELS.industryResearchRemoveCompany, args: ["item-1", "company-1"] },
      { channel: IPC_CHANNELS.industryResearchRemoveCompanies, args: ["item-1", ["company-1", "company-2"]] },
      { channel: IPC_CHANNELS.industryResearchRecognizeCompanies, args: ["item-1", "公司甲"] },
      { channel: IPC_CHANNELS.industryResearchRetryCompanyProfile, args: ["company-1"] },
      { channel: IPC_CHANNELS.industryResearchSubscribeCompanyProfiles, args: [] },
      { channel: IPC_CHANNELS.companyResearchStart, args: ["item-1", "company-1", { direction: "product_and_technology", asOfDate: "2026-09-11" }] },
      { channel: IPC_CHANNELS.companyResearchCancel, args: ["run-1"] },
      { channel: IPC_CHANNELS.companyResearchGetState, args: ["item-1", "company-1"] },
      { channel: IPC_CHANNELS.companyResearchListRuns, args: ["item-1", "company-1"] },
      { channel: IPC_CHANNELS.companyResearchGetRun, args: ["item-1", "company-1", "run-1"] },
      { channel: IPC_CHANNELS.companyResearchRetryFailed, args: ["item-1", "company-1", "run-1", retryInput] },
      { channel: IPC_CHANNELS.companyResearchDeleteRun, args: ["item-1", "company-1", "run-1"] },
      { channel: IPC_CHANNELS.settingsGet, args: [] },
      { channel: IPC_CHANNELS.settingsSaveLlmProfile, args: [llmDraft] },
      { channel: IPC_CHANNELS.settingsActivateLlmProfile, args: ["l1"] },
      { channel: IPC_CHANNELS.settingsDeleteLlmProfile, args: ["l1"] },
      { channel: IPC_CHANNELS.settingsDiagnoseLlm, args: [llmDraft] },
      { channel: IPC_CHANNELS.settingsSaveSearchProfile, args: [searchDraft] },
      { channel: IPC_CHANNELS.settingsActivateSearchProfile, args: ["s1"] },
      { channel: IPC_CHANNELS.settingsDeleteSearchProfile, args: ["s1"] },
      { channel: IPC_CHANNELS.settingsDiagnoseSearch, args: [searchDraft] },
      { channel: IPC_CHANNELS.conversationsCreate, args: [] },
      { channel: IPC_CHANNELS.conversationsOpenInitial, args: [] },
      { channel: IPC_CHANNELS.conversationsListRecent, args: [] },
      { channel: IPC_CHANNELS.skillsList, args: [] },
      { channel: IPC_CHANNELS.chatSend, args: ["conv-1", "你好", "req-1", CHAT_OPTIONS] },
      { channel: IPC_CHANNELS.chatListMessages, args: ["conv-1"] },
    ]);
  });

  it("validates worker events before forwarding and supports unsubscribe", () => {
    const { ipc, listeners } = makeFakeIpc();
    const api = createPreloadApi(ipc);
    const received: AgentWorkerEvent[] = [];
    const unsubscribe = api.chat.subscribe((event) => {
      received.push(event);
    });
    const set = listeners.get(IPC_CHANNELS.chatEvents);
    expect(set?.size).toBe(1);

    const valid: AgentWorkerEvent = { requestId: "r", type: "text_delta", delta: "你好" };
    const invalid = { requestId: "r", type: "text_delta" };
    for (const listener of [...(set ?? [])]) {
      listener({}, valid);
      listener({}, invalid);
    }
    expect(received).toEqual([valid]);

    unsubscribe();
    expect(set?.size).toBe(0);

    const researchReceived: CompanyResearchEvent[] = [];
    const unsubscribeResearch = api.companyResearch.subscribe((event) => researchReceived.push(event));
    const researchSet = listeners.get(IPC_CHANNELS.companyResearchEvents);
    const validResearch: CompanyResearchEvent = {
      itemId: "item-1",
      companyId: "company-1",
      runId: "run-1",
      type: "state_changed",
    };
    const rawDelta: CompanyResearchEvent = { requestId: "rr", runId: "run-1", stage: "raw", type: "text_delta", delta: "# raw" };
    const activity: CompanyResearchEvent = { requestId: "rr", runId: "run-1", stage: "raw", type: "tool_activity", callKey: "tool-1", name: "web_search", summary: "宇树科技", status: "running" };
    for (const listener of [...(researchSet ?? [])]) {
      listener({}, validResearch);
      listener({}, rawDelta);
      listener({}, activity);
      listener({}, { ...validResearch, type: "text_delta" });
      listener({}, { ...validResearch, apiKey: "sk-secret" });
      listener({}, { ...rawDelta, stage: "structure" });
      for (const stage of ["raw", "structure"]) {
        const identity = { requestId: "rr", runId: "run-1", stage };
        listener({}, { ...identity, type: "started" });
        listener({}, { ...identity, type: "completed", text: '{"candidate":true}' });
        listener({}, { ...identity, type: "cancelled" });
        listener({}, { ...identity, type: "failed", code: stage === "raw" ? "research_failed" : "structuring_failed", message: stage === "raw" ? "company research failed" : "company research structuring failed" });
      }
      listener({}, valid);
    }
    expect(researchReceived).toEqual([validResearch, rawDelta, activity]);
    unsubscribeResearch();
    expect(researchSet?.size).toBe(0);

    const profileReceived: CompanyProfileEvent[] = [];
    const unsubscribeProfile = api.industryResearch.subscribeCompanyProfiles((event) => profileReceived.push(event));
    const profileSet = listeners.get(IPC_CHANNELS.industryResearchCompanyProfileEvents);
    const validProfile: CompanyProfileEvent = { companyId: "company-1", status: "ready" };
    for (const listener of [...(profileSet ?? [])]) {
      listener({}, validProfile);
      listener({}, { companyId: "company-1", status: "bogus" });
    }
    expect(profileReceived).toEqual([validProfile]);
    unsubscribeProfile();
    expect(profileSet?.size).toBe(0);
  });
});
