// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InteractionRecord } from "@deepfield/contracts";
import { ChatInteractionCard } from "./ChatInteractionCard.js";

const base: InteractionRecord = {
  id: "i1", conversationId: "c1", requestId: "r1", toolCallId: "tool1", revision: 2,
  status: "waiting", createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z",
  payload: { kind: "question", question: "选哪个？", options: [{ id: "a", label: "方案 A" }, { id: "b", label: "方案 B" }], allowFreeText: true },
};

describe("ChatInteractionCard", () => {
  it("preserves an authoritative continuation failure warning alongside the successful result link", () => {
    const warning = "添加完成。后续表单准备失败，请重新打开表单；不要重复执行已完成的操作。";
    const interaction: InteractionRecord = { ...base, status: "succeeded", resultSummary: warning,
      payload: { kind: "approval", summary: "添加公司", operation: { provider: "capability", operationId: "opaque", contractVersion: "1" } } };
    render(<ChatInteractionCard interaction={interaction} respond={vi.fn()} open={vi.fn()}
      operation={{ conversationId: "c1", sourceRequestId: "r1", invocationId: "invocation", status: "completed", title: "", presentation: { text: "添加完成。", target: { capabilityId: "company", viewId: "list", input: {} }, linkLabel: "查看公司" } }} />);
    expect(screen.getByText(warning)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "查看公司" })).toHaveLength(1);
    expect(screen.queryByText("添加完成。")).toBeNull();
  });
  it("does not answer a question until the user submits the selected option", async () => {
    const respond = vi.fn(async () => ({ ...base, status: "answered" as const }));
    render(<ChatInteractionCard interaction={base} respond={respond} />);
    fireEvent.click(screen.getByLabelText("方案 A"));
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ interactionId: "i1", expectedRevision: 2, response: { kind: "answer", text: "方案 A" } }));
  });

  it("offers one approval decision without rendering business fields", () => {
    const approval: InteractionRecord = { ...base, payload: { kind: "approval", summary: "创建主题", operation: { provider: "company", operationId: "create", contractVersion: "1" } } };
    render(<ChatInteractionCard interaction={approval} respond={vi.fn(async () => approval)} />);
    expect(screen.getByText("创建主题")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "确认执行" })).toHaveLength(1);
    expect(screen.queryByText("后续分析")).toBeNull();
  });
  it("allows cancellation during editing while blocking approval and hides internal failure details", async () => {
    const approval: InteractionRecord = { ...base, status: "editing", payload: { kind: "approval", summary: "创建主题", operation: { provider: "company", operationId: "create", contractVersion: "1" } } };
    const respond = vi.fn(async () => ({ ...approval, status: "cancelled" as const }));
    const view = render(<ChatInteractionCard interaction={approval} respond={respond} />);
    expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith({ interactionId: "i1", expectedRevision: 2, response: { kind: "decision", decision: "cancel" } }));
    view.rerender(<ChatInteractionCard interaction={{ ...approval, status: "failed", failureReason: "draft_ref_deleted: secret" }} respond={respond} />);
    expect(screen.queryByText(/draft_ref_deleted/)).toBeNull();
    expect(screen.getByText("操作未完成，请检查状态后重试。")).toBeTruthy();
  });
});
