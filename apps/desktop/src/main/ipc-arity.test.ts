import { describe, expect, it } from "vitest";
import { IPC_CHANNELS } from "../preload/preload-api.js";
import {
  DEFAULT_CHAT_OPTIONS,
  event,
  FakeWebContents,
  makeDeps,
  RESEARCH_INPUT,
} from "./ipc-test-helpers.js";

describe("generic IPC arity", () => {
  it("rejects extra capability arguments before package lookup", async () => {
    const { ipcMain, dispose } = makeDeps();
    const sender = new FakeWebContents(1);
    await expect(ipcMain.invoke(IPC_CHANNELS.capabilityInvoke, event(sender), { capabilityId: "company-research", operation: "companyResearch.cancel", requestId: "r", input: ["run-1"] }, "extra")).resolves.toMatchObject({ ok: false, error: { code: "INPUT.INVALID" } });
    expect(sender.destroyedListenerCount).toBe(0);
    dispose();
  });
});
