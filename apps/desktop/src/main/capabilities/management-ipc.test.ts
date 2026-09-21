import { expect, it, vi } from "vitest";
import { registerCapabilityManagementIpc } from "./management-ipc.js";
import { IPC_CHANNELS } from "../../preload/preload-api.js";
import { createPreloadApi } from "../../preload/preload-api.js";
import type { IpcEventLike } from "../ipc.js";

it("bounds management writes, strips raw issues, and releases subscriptions", async () => {
  const handlers = new Map<string, (event: IpcEventLike, ...args: unknown[]) => unknown>();
  const dispose = vi.fn(); const setEnabled = vi.fn(async () => { throw new Error("sk-secret"); });
  const runtime = { list: () => [], issues: [{ packageName: "sk-secret", code: "sk-secret" }], setEnabled, subscribe: () => dispose };
  const sender = { id: 1, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
  const cleanup = registerCapabilityManagementIpc({ handle: (channel, handler) => { handlers.set(channel, handler); }, removeHandler: channel => { handlers.delete(channel); } }, runtime);
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender }, ...args);
  const snapshot = await call(IPC_CHANNELS.capabilityManagementList);
  expect(snapshot).toEqual({ ok: true, value: { packages: [], issues: [{ code: "unavailable", message: "能力不可用" }] } });
  expect(JSON.stringify(snapshot)).not.toContain("sk-secret");
  const invalid = await call(IPC_CHANNELS.capabilityManagementSetEnabled, "x".repeat(101), true);
  expect(invalid).toMatchObject({ ok: false }); expect(setEnabled).not.toHaveBeenCalled();
  const failed = await call(IPC_CHANNELS.capabilityManagementSetEnabled, "example", true);
  expect(failed).toMatchObject({ ok: false }); expect(JSON.stringify(failed)).not.toContain("sk-secret");
  await call(IPC_CHANNELS.capabilityManagementSubscribe);
  await call(IPC_CHANNELS.capabilityManagementUnsubscribe);
  expect(dispose).toHaveBeenCalledTimes(1);
  cleanup(); expect(handlers.size).toBe(0);
});

it("preload rejects malformed snapshots and arguments and refcounts listeners", async () => {
  const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => ({ ok: true, value: { packages: [], issues: [], secret: "raw" } }));
  const remove = vi.fn();
  const api = createPreloadApi({ invoke, on: () => remove }).capabilityManagement;
  await expect(api.list()).rejects.toBeDefined();
  await expect(api.setEnabled("../bad", true)).rejects.toBeDefined();
  const one = api.subscribe(() => {}); const two = api.subscribe(() => {});
  one(); one(); two();
  expect(remove).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls.filter(args => args[0] === IPC_CHANNELS.capabilityManagementSubscribe)).toHaveLength(1);
  expect(invoke.mock.calls.filter(args => args[0] === IPC_CHANNELS.capabilityManagementUnsubscribe)).toHaveLength(1);
});

it("isolates an oversized package DTO without dropping valid navigation", async () => {
  let list!: (event: IpcEventLike) => unknown;
  const entry = { id: "example", name: "Example", description: "", version: "1.0.0", status: "ready" as const, enabledNextStart: true, navigation: { title: "Example", order: 0, route: "/example" }, uiEntry: "deepfield-capability://example/dist/ui.js" };
  registerCapabilityManagementIpc({ handle: (channel, handler) => { if (channel === IPC_CHANNELS.capabilityManagementList) list = handler; }, removeHandler() {} }, {
    list: () => [{ ...entry, id: "bad", name: "x".repeat(201) }, entry], issues: [], subscribe: () => () => {}, setEnabled: async () => {},
  });
  expect(await list({} as IpcEventLike)).toMatchObject({ ok: true, value: { packages: [entry], issues: [{ code: "invalid_manifest" }] } });
});
