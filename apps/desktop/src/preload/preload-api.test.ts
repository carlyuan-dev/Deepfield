import { describe, expect, it } from "vitest";
import {
  createPreloadApi,
  IPC_CHANNELS,
  type IpcBridge,
} from "./preload-api.js";
import type { AgentWorkerEvent, ChatRequestOptions, DesktopApi } from "@deepfield/contracts";

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
  it("exposes only the DesktopApi shape without ipcRenderer or secrets", () => {
    const { ipc } = makeFakeIpc();
    const api: DesktopApi = createPreloadApi(ipc);
    expect(Object.keys(api).sort()).toEqual([
      "chat",
      "conversations",
      "industryResearch",
      "llm",
      "settings",
      "skills",
    ]);
    expect(Object.keys(api.conversations).sort()).toEqual(["create", "listRecent", "openInitial"]);
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
      "updateItem",
    ]);
    expect(Object.keys(api.settings).sort()).toEqual(["hasDeepSeekKey", "setDeepSeekKey"]);
    expect(Object.keys(api.llm).sort()).toEqual(["checkConnection"]);
    expect(Object.keys(api.skills).sort()).toEqual(["list"]);
    expect(Object.keys(api.chat).sort()).toEqual(["listMessages", "send", "subscribe"]);
    expect(JSON.stringify(api)).not.toContain("ipcRenderer");
    expect(JSON.stringify(api)).not.toContain("apiKey");
    expect(JSON.stringify(api)).not.toContain("deepseek");
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
    await api.industryResearch.addCompany("item-1", { name: "公司甲" });
    await api.industryResearch.addCompanies("item-1", [{ name: "公司乙" }]);
    await api.industryResearch.removeCompany("item-1", "company-1");
    await api.industryResearch.removeCompanies("item-1", ["company-1", "company-2"]);
    await api.industryResearch.recognizeCompanies("item-1", "公司甲");
    await api.settings.hasDeepSeekKey();
    await api.settings.setDeepSeekKey("sk-value");
    await api.llm.checkConnection();
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
      { channel: IPC_CHANNELS.industryResearchAddCompany, args: ["item-1", { name: "公司甲" }] },
      { channel: IPC_CHANNELS.industryResearchAddCompanies, args: ["item-1", [{ name: "公司乙" }]] },
      { channel: IPC_CHANNELS.industryResearchRemoveCompany, args: ["item-1", "company-1"] },
      { channel: IPC_CHANNELS.industryResearchRemoveCompanies, args: ["item-1", ["company-1", "company-2"]] },
      { channel: IPC_CHANNELS.industryResearchRecognizeCompanies, args: ["item-1", "公司甲"] },
      { channel: IPC_CHANNELS.settingsHasDeepSeekKey, args: [] },
      { channel: IPC_CHANNELS.settingsSetDeepSeekKey, args: ["sk-value"] },
      { channel: IPC_CHANNELS.llmCheckConnection, args: [] },
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
  });
});
