import { describe, expect, it, vi } from "vitest";
import { AppError } from "@deepfield/contracts";
import { createPreloadApi, IPC_CHANNELS } from "../preload/preload-api.js";
import { makeDeps, FakeWebContents, event } from "./ipc-test-helpers.js";

describe("selected public error IPC boundary", () => {
  it("round trips typed errors and successful research through cloned result envelopes", async () => {
    const { ipcMain, companyResearch } = makeDeps();
    const sender = new FakeWebContents(1);
    const api = createPreloadApi({ invoke: async (channel, ...args) => structuredClone(await ipcMain.invoke(channel, event(sender), ...args)), on: () => () => {} });
    const input = { direction: "product_and_technology", asOfDate: "2026-09-11" } as const;
    expect(await api.companyResearch.start("item-1", "company-1", input)).toMatchObject({ id: "run-1", status: "researching" });
    vi.spyOn(companyResearch, "start").mockRejectedValue(new AppError("CONFIG.CREDENTIAL_MISSING", { service: "search" }, { cause: new Error("secret token") }));
    await expect(api.companyResearch.start("item-1", "company-1", input)).rejects.toEqual({ code: "CONFIG.CREDENTIAL_MISSING", category: "configuration", context: { service: "search" } });
    expect(await ipcMain.invoke(IPC_CHANNELS.companyResearchStart, event(sender), "item-1", "company-1", {})).toEqual({ ok: false, error: { code: "INPUT.INVALID", category: "input" } });
  });
  it.each([
    { ok: false, error: { code: "CONFIG.INVALID", category: "configuration", message: "secret token" } },
    { ok: true, value: { apiKey: "secret token" } },
    { error: "secret token" },
  ])("rejects malformed responses without returning secret-bearing data", async (response) => {
    const api = createPreloadApi({ invoke: async () => response, on: () => () => {} });
    await expect(api.companyResearch.start("i", "c", {} as never)).rejects.toEqual({ code: "INTERNAL.UNKNOWN", category: "internal" });
  });
  it("sanitizes a transport rejection itself", async () => {
    const api = createPreloadApi({ invoke: async () => { throw new Error("secret token"); }, on: () => () => {} });
    await expect(api.settings.diagnoseLlm({} as never)).rejects.toEqual({ code: "INTERNAL.UNKNOWN", category: "internal" });
  });
  it("does not relay diagnostic legacy message strings to the renderer", async () => {
    const api = createPreloadApi({ invoke: async () => ({ ok: true, value: { ok: false, latencyMs: 0, code: "provider_error", message: "secret token" } }), on: () => () => {} });
    const result = await api.settings.diagnoseLlm({} as never);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
