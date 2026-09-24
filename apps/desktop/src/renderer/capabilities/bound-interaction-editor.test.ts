import { describe, expect, it, vi } from "vitest";
import type { DesktopApi, InteractionRecord } from "@deepfield/contracts";
import { makeFakeApi } from "../renderer-test-helpers.js";
import { createBoundInteractionEditor } from "./bound-interaction-editor.js";

describe("bound interaction editor", () => {
  const record: InteractionRecord = { id: "i1", conversationId: "original", requestId: "r1", toolCallId: "t1",
    revision: 5, status: "waiting", createdAt: "2026-09-23", updatedAt: "2026-09-23",
    payload: { kind: "approval", summary: "保存", operation: { provider: "test", operationId: "save", contractVersion: "1" } } };
  it("keeps its original owner and rejects a stale version without submitting", async () => {
    const api = makeFakeApi();
    const conflict = new Error("revision_conflict");
    api.chat.updateInteractionEditor.mockRejectedValue(conflict);
    api.chat.respondInteractionEditor.mockResolvedValue({ ...record, status: "submitted" });
    const editor = createBoundInteractionEditor(api.chat as DesktopApi["chat"], { conversationId: "original", interactionId: "i1" }, () => {});
    await expect(editor.update(4, { notes: "新内容" })).rejects.toBe(conflict);
    expect(api.chat.updateInteractionEditor).toHaveBeenCalledWith("original", "i1", 4, { notes: "新内容" });
    expect(api.chat.respondInteractionEditor).not.toHaveBeenCalled();
    await editor.respond(5, "approve");
    expect(api.chat.respondInteractionEditor).toHaveBeenCalledWith("original", { interactionId: "i1", expectedRevision: 5, response: { kind: "decision", decision: "approve" } });
  });
  it("keeps the form bound when approval returns waiting after a conflict", async () => {
    const api = makeFakeApi();
    const terminal = vi.fn();
    api.chat.respondInteractionEditor.mockResolvedValue(record);
    const editor = createBoundInteractionEditor(api.chat as DesktopApi["chat"], { conversationId: "original", interactionId: "i1" }, terminal);
    await expect(editor.respond(4, "approve")).rejects.toThrow("内容已更新，请核对后重试。");
    expect(terminal).not.toHaveBeenCalled();
  });
});
