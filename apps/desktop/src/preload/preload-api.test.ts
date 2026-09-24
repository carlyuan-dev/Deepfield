import { describe, expect, it } from "vitest";
import {
  createPreloadApi,
  IPC_CHANNELS,
  type IpcBridge,
} from "./preload-api.js";
import type { AgentWorkerEvent, ChatRequestOptions, DesktopApi } from "@deepfield/contracts";
import type { CompanyResearchEvent, CompanyProfileEvent } from "../../../../capabilities/company-research/contracts/index.js";

import { researchRun } from "../../../../capabilities/company-research/ui/company-research-test-fixtures.js";

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
      if (channel === IPC_CHANNELS.settingsDiagnoseLlm || channel === IPC_CHANNELS.settingsDiagnoseSearch) return { ok: true, value: { ok: true, latencyMs: 0, summary: "连接正常" } };
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
  it("routes interaction decisions and bound editor responses through distinct channels", async () => {
    const invokes: Array<{ channel: string; args: unknown[] }> = [];
    const record = { id: "i1", conversationId: "c1", requestId: "r1", toolCallId: "t1", revision: 1,
      status: "waiting", createdAt: "now", updatedAt: "now", payload: { kind: "approval", summary: "Create", operation: { provider: "example", operationId: "a", contractVersion: "1" } } };
    const api = createPreloadApi({ invoke: async (channel, ...args) => { invokes.push({ channel, args }); return { ok: true, value: record }; }, on: () => () => {} });
    const command = { interactionId: "i1", expectedRevision: 1, response: { kind: "decision" as const, decision: "approve" as const } };
    await api.chat.respondInteraction!("c1", command);
    await api.chat.respondInteractionEditor!("c1", command);
    expect(invokes).toEqual([
      { channel: "chat:interactions:respond", args: ["c1", command] },
      { channel: "chat:interactions:editor-respond", args: ["c1", command] },
    ]);
  });
  it("uses a fixed guarded auto-open channel and validates the navigation result", async () => {
    const invokes: Array<{ channel: string; args: unknown[] }> = [];
    const api = createPreloadApi({ invoke: async (channel, ...args) => { invokes.push({ channel, args }); return { ok: true, value: { status: "opened" } }; }, on: () => () => {} });
    await expect(api.chat.autoOpenInteractionEditor("c1", "i1")).resolves.toEqual({ status: "opened" });
    await expect(api.chat.openInteractionEditor("c1", "i1")).resolves.toEqual({ status: "opened" });
    expect(invokes).toEqual([{ channel: "chat:interactions:editor-auto-open", args: ["c1", "i1"] },
      { channel: "chat:interactions:editor-open", args: ["c1", "i1"] }]);
  });
  it("requests restart through one fixed no-argument channel", async () => {
    const invokes: Array<{ channel: string; args: unknown[] }> = [];
    const api = createPreloadApi({
      invoke: async (channel, ...args) => { invokes.push({ channel, args }); return { ok: true, value: null }; },
      on: () => () => {},
    }).capabilityManagement as CapabilityManagementApiWithRestart;

    await api.restart();

    expect(invokes).toEqual([{ channel: "deepfield:capability-management:restart", args: [] }]);
  });
  it("exposes only a validated unknown-usage deletion snapshot call", async () => {
    const invokes: Array<{ channel: string; args: unknown[] }> = [];
    const api = createPreloadApi({ invoke: async (channel, ...args) => { invokes.push({ channel, args }); return { ok: true, value: 1 }; }, on: () => () => {} });
    await expect(api.usage.deleteUnknownFailures([{ attemptId: "attempt-1", revision: 2 }])).resolves.toBe(1);
    expect(invokes).toEqual([{ channel: IPC_CHANNELS.usageDeleteUnknownFailures, args: [[{ attemptId: "attempt-1", revision: 2 }]] }]);
    await expect(api.usage.deleteUnknownFailures([{ attemptId: "bad id", revision: 2 }])).rejects.toBeDefined();
    expect(invokes).toHaveLength(1);
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

  it("exposes only a controlled capability bridge and scopes event listener lifetime", async () => {
    const { ipc, invokes, listeners } = makeFakeIpc();
    const api = createPreloadApi(ipc);
    expect(Object.keys(api.capabilities)).toEqual(["invoke", "subscribe"]);
    expect(api).not.toHaveProperty("companyResearch");
    expect(api).not.toHaveProperty("industryResearch");
    const events: unknown[] = [];
    const unsubscribe = api.capabilities.subscribe(event => events.push(event));
    const listener = [...listeners.get(IPC_CHANNELS.capabilityEvents)!][0]!;
    listener({}, { capabilityId: "example", topic: "updated", payload: { count: 1 } });
    listener({}, { capabilityId: "example", topic: "updated", payload: 1, secret: "bad" });
    expect(events).toHaveLength(1);
    unsubscribe(); unsubscribe();
    expect(listeners.get(IPC_CHANNELS.capabilityEvents)?.size).toBe(0);
    expect(invokes.map(value => value.channel)).toEqual([IPC_CHANNELS.capabilitySubscribe, IPC_CHANNELS.capabilityUnsubscribe]);
    const controlled = createPreloadApi({ ...ipc, invoke: async (channel, ...args) => { invokes.push({ channel, args }); return { ok: true, value: "result" }; } });
    const call = { capabilityId: "example", operation: "echo", requestId: "r", input: [1] };
    expect(await controlled.capabilities.invoke(call)).toBe("result");
    expect(invokes.at(-1)).toEqual({ channel: IPC_CHANNELS.capabilityInvoke, args: [call] });
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
});

interface CapabilityManagementApiWithRestart {
  restart(): Promise<void>;
}
