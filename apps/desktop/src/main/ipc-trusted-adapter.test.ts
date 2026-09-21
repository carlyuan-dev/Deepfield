import { describe, expect, it } from "vitest";
import { FakeWebContents, makeDeps, RESEARCH_INPUT } from "./ipc-test-helpers.js";
import { registerIpcHandlers } from "./ipc.js";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  createTrustedIpcMainAdapter,
  type RendererIpcEventLike,
} from "./ipc-trusted-adapter.js";

const LOCAL_URL = "file:///Applications/Deepfield.app/out/renderer/index.html";
const DEV_URL = "http://localhost:5173/";

class RendererSender extends FakeWebContents {
  mainFrame = { url: LOCAL_URL };
  dead = false;
  isDestroyed(): boolean { return this.dead; }
}

function setup(expectedUrl = LOCAL_URL) {
  const services = makeDeps();

  const handlers = new Map<string, (event: RendererIpcEventLike, ...args: unknown[]) => unknown>();
  const sender = new RendererSender(1);
  sender.mainFrame.url = expectedUrl;
  let trusted: RendererSender | undefined = sender;
  const adapter = createTrustedIpcMainAdapter({
    handle: (channel, listener) => { handlers.set(channel, listener); },
    removeHandler: (channel) => { handlers.delete(channel); },
  }, () => trusted, expectedUrl);
  const dispose = registerIpcHandlers({ ...services, ipcMain: adapter });
  const event: RendererIpcEventLike & { sender: RendererSender } = { sender, senderFrame: sender.mainFrame };
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error("missing test handler");
    return handler(event, ...args);
  };
  return { ...services, sender, event, invoke, handlers, dispose, setTrusted: (value: RendererSender | undefined) => { trusted = value; } };
}

describe("trusted renderer IPC adapter", () => {
  it.each([
    [LOCAL_URL, LOCAL_URL],
    [LOCAL_URL, `${LOCAL_URL}#/reports`],
    [DEV_URL, `${DEV_URL}reports?run=1`],
    ["https://localhost:5173/", "https://localhost:5173/reports"],
  ])("dispatches the known main frame at %s (%s)", async (expected, actual) => {
    const { sender, invoke, companyResearch, companyResearchWordExport, dispose, handlers } = setup(expected);
    sender.mainFrame.url = actual;
    expect(handlers.has(IPC_CHANNELS.capabilityInvoke)).toBe(true);
    await invoke(IPC_CHANNELS.capabilitySubscribe);
    await expect(invoke(IPC_CHANNELS.capabilityInvoke, { capabilityId: "company-research", operation: "companyResearch.start", requestId: "r", input: ["item-1", "company-1", RESEARCH_INPUT] })).resolves.toMatchObject({ ok: true, value: { status: "researching" } });
    await expect(invoke(IPC_CHANNELS.capabilityInvoke, { capabilityId: "company-research", operation: "companyResearch.retryFailed", requestId: "r", input: ["item-1", "company-1", "run-1", RESEARCH_INPUT] })).resolves.toMatchObject({ ok: true, value: { id: "run-1" } });
    await expect(invoke(IPC_CHANNELS.capabilityInvoke, { capabilityId: "company-research", operation: "companyResearch.deleteRun", requestId: "r", input: ["item-1", "company-1", "run-1"] })).resolves.toMatchObject({ ok: true });
    await expect(invoke(IPC_CHANNELS.capabilityInvoke, { capabilityId: "company-research", operation: "companyResearch.exportWord", requestId: "r", input: ["item-1", "company-1", "run-1", { raw: false, structured: true }] })).resolves.toEqual({ ok: true, value: { status: "cancelled" } });
    expect(companyResearch.startCalls).toHaveLength(1);
    expect(companyResearch.retryFailedCalls).toHaveLength(1);
    expect(companyResearch.deleteRunCalls).toHaveLength(1);
    expect(companyResearchWordExport.exportCalls).toHaveLength(1);
    expect(sender.destroyedListenerCount).toBe(1);
    dispose();
    expect(handlers.size).toBe(0);
    expect(handlers.has(IPC_CHANNELS.capabilityInvoke)).toBe(false);
    expect(sender.destroyedListenerCount).toBe(0);
  });

  it.each([
    "foreign window", "same id different object", "subframe", "missing frame",
    "no main window", "destroyed sender", "remote URL", "other local file",
    "changed file query", "file hostname", "blank URL", "malformed URL",
    "data URL", "dev wrong port", "dev wrong host", "dev wrong scheme",
    "empty expected URL",
  ])("rejects %s before service calls or subscription registration", async (scenario) => {
    const context = setup(scenario.startsWith("dev ") ? DEV_URL : scenario === "empty expected URL" ? "" : LOCAL_URL);
    const { sender, event, invoke, companyResearch, setTrusted } = context;
    switch (scenario) {
      case "foreign window": event.sender = new RendererSender(2); event.senderFrame = event.sender.mainFrame; break;
      case "same id different object": event.sender = new RendererSender(1); event.senderFrame = event.sender.mainFrame; break;
      case "subframe": event.senderFrame = { url: LOCAL_URL }; break;
      case "missing frame": event.senderFrame = null; break;
      case "no main window": setTrusted(undefined); break;
      case "destroyed sender": sender.dead = true; break;
      case "remote URL": sender.mainFrame.url = "https://evil.example/private?key=secret"; break;
      case "other local file": sender.mainFrame.url = "file:///tmp/other.html"; break;
      case "changed file query": sender.mainFrame.url = `${LOCAL_URL}?injected=1`; break;
      case "file hostname": sender.mainFrame.url = LOCAL_URL.replace("file:///", "file://remote/"); break;
      case "blank URL": sender.mainFrame.url = ""; break;
      case "malformed URL": sender.mainFrame.url = "not a URL"; break;
      case "data URL": sender.mainFrame.url = "data:text/html,hello"; break;
      case "dev wrong port": sender.mainFrame.url = "http://localhost:5174/"; break;
      case "dev wrong host": sender.mainFrame.url = "http://evil.example:5173/"; break;
      case "dev wrong scheme": sender.mainFrame.url = "https://localhost:5173/"; break;
    }
    for (const [channel, args] of [
      [IPC_CHANNELS.capabilitySubscribe, []],
      [IPC_CHANNELS.capabilityInvoke, [{ capabilityId: "company-research", operation: "companyResearch.start", requestId: "r", input: ["item-1", "company-1", RESEARCH_INPUT] }]],
      [IPC_CHANNELS.capabilityInvoke, [{ capabilityId: "company-research", operation: "companyResearch.exportWord", requestId: "r", input: ["item-1", "company-1", "run-1", { raw: false, structured: true }] }]],
    ] as const) {
      const error = await invoke(channel, ...args).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("untrusted IPC sender");
    }
    expect(companyResearch.startCalls).toHaveLength(0);
    expect(sender.destroyedListenerCount).toBe(0);
    expect(event.sender.destroyedListenerCount).toBe(0);
    companyResearch.emit({ type: "state_changed", itemId: "item-1", companyId: "company-1", runId: "run-1" });
    expect(event.sender.sent).toEqual([]);
  });

  it("rechecks the current window on each invocation after replacement", async () => {
    const { sender, event, invoke, setTrusted, companyResearch } = setup();
    const replacement = new RendererSender(2);
    setTrusted(replacement);
    await expect(invoke(IPC_CHANNELS.capabilitySubscribe)).rejects.toThrow("untrusted IPC sender");
    expect(sender.destroyedListenerCount).toBe(0);
    event.sender = replacement;
    event.senderFrame = replacement.mainFrame;
    await invoke(IPC_CHANNELS.capabilitySubscribe);
    companyResearch.emit({ type: "state_changed", itemId: "item-1", companyId: "company-1", runId: "run-1" });
    expect(replacement.sent).toHaveLength(1);
    expect(sender.sent).toEqual([]);
  });
});
