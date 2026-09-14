// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";
import type { ChatSendResult } from "@deepfield/contracts";
import {
  chatMessage,
  chatSendResult,
  conversation,
  makeFakeApi,
  workerEvent,
  type FakeDesktopApi,
} from "./renderer-test-helpers.js";

const REQUEST_ID = "req-early";

async function renderApp(fake: FakeDesktopApi) {
  const user = userEvent.setup();
  const utils = render(<App api={fake} requestIdFactory={() => REQUEST_ID} />);
  return { user, ...utils };
}

async function openConversation(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole("button", { name: label }));
}

describe("app chat edge cases", () => {
  it("confirms idle deletion and falls back from the active conversation", async () => {
    const fake = makeFakeApi();
    const first = conversation("p1", "人形机器人", true);
    const second = conversation("p2", "低空经济", true);
    fake.conversations.openInitial.mockResolvedValue({ active: first, recent: [first, second] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user } = await renderApp(fake);
    await openConversation(user, "人形机器人");
    await user.click(screen.getByRole("button", { name: "删除人形机器人" }));
    await waitFor(() => expect(fake.conversations.delete).toHaveBeenCalledWith("p1"));
    expect(screen.getByRole("button", { name: "低空经济" }).getAttribute("aria-current")).toBe("page");
  });

  it("rejects deletion while that conversation is generating", async () => {
    const fake = makeFakeApi(); const active = conversation("p1", "人形机器人", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.send.mockImplementation(() => new Promise(() => {}));
    const confirm = vi.spyOn(window, "confirm").mockClear().mockReturnValue(true);
    const { user } = await renderApp(fake); await openConversation(user, "人形机器人");
    await user.type(screen.getByLabelText("消息输入"), "问题");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(screen.getByRole("button", { name: "删除人形机器人" }));
    expect(await screen.findByText("对话生成中，请等待完成后再删除")).toBeTruthy();
    expect(fake.conversations.delete).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("routes early events to the originating conversation even after switching", async () => {
    const fake = makeFakeApi();
    const first = conversation("p1", "人形机器人", true);
    const second = conversation("p2", "低空经济", true);
    fake.conversations.openInitial.mockResolvedValue({ active: first, recent: [first, second] });
    fake.chat.listMessages.mockImplementation(async (conversationId: string) =>
      conversationId === "p1"
        ? [chatMessage("m1", "user", "你好"), chatMessage("m2", "assistant", "最终")]
        : [],
    );
    let resolveSend!: (value: ChatSendResult) => void;
    fake.chat.send.mockImplementation(
      () =>
        new Promise<ChatSendResult>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { user } = await renderApp(fake);
    await openConversation(user, "人形机器人");

    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    // events arrive before send resolves while still in p1
    fake.emit(workerEvent(REQUEST_ID, "started"));
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "早"));
    await waitFor(() => expect(screen.getByText("早")).toBeTruthy());

    // switch to p2 before the send resolves
    await openConversation(user, "低空经济");
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "串"));
    await waitFor(() => expect(screen.queryByText("串")).toBeNull());
    await waitFor(() => expect(screen.getByText("还没有消息")).toBeTruthy());

    // send resolves; activity remains owned by p1 and must not appear in p2
    resolveSend(chatSendResult(REQUEST_ID, "p1", "人形机器人"));

    // back to p1 while still running: partial output is restored immediately
    await openConversation(user, "人形机器人");
    await waitFor(() => expect(screen.getByText("早串")).toBeTruthy());
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "续"));
    await waitFor(() => expect(screen.getByText("早串续")).toBeTruthy());
    fake.emit(workerEvent(REQUEST_ID, "completed", "最终"));
    await waitFor(() => expect(screen.getByText("最终")).toBeTruthy());
  });

  it("hydrates safe terminal tool history for an existing assistant reply", async () => {
    const fake = makeFakeApi(); const active = conversation("p1", "人形机器人", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.listMessages.mockResolvedValue([
      { ...chatMessage("m1", "user", "问题"), requestId: "req-history" },
      { ...chatMessage("m2", "assistant", "回答"), requestId: "req-history", toolExecutions: [{ callKey: "tool-1", name: "fetch_url", status: "failed", durationMs: 2000, errorCode: "timeout" }] },
    ]);
    const { user } = await renderApp(fake); await openConversation(user, "人形机器人");
    expect(await screen.findByText("已调用 1 个工具")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /已调用 1 个工具/ }));
    expect(screen.getByText("读取网页")).toBeTruthy();
    expect(screen.getByText(/2000ms/)).toBeTruthy();
    expect(screen.getByText(/timeout/)).toBeTruthy();
  });

  it("removes the optimistic user and restores the composer when send is rejected", async () => {
    const fake = makeFakeApi();
    const active = conversation("p1", "人形机器人", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.send.mockRejectedValue(new Error("deepseek key missing"));
    const { user } = await renderApp(fake);
    await openConversation(user, "人形机器人");

    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // the optimistic user is removed (not persisted) and the composer keeps the text
    await waitFor(() => expect(document.querySelector(".message.user")).toBeNull());
    expect((screen.getByLabelText("消息输入") as HTMLTextAreaElement).value).toBe("你好");
  });

  it("treats a mismatched returned request id as a protocol error and cleans up", async () => {
    const fake = makeFakeApi();
    const active = conversation("p1", "人形机器人", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.send.mockResolvedValue(chatSendResult("different-id"));
    const { user } = await renderApp(fake);
    await openConversation(user, "人形机器人");

    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    await waitFor(() => expect(document.querySelector(".message.user")).toBeNull());
    // events for the mismatched id are not routed anywhere
    fake.emit(workerEvent(REQUEST_ID, "started"));
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "串"));
    await waitFor(() => expect(screen.queryByText("串")).toBeNull());
  });

  it("shows a load error with a working reload action", async () => {
    const fake = makeFakeApi();
    const active = conversation("p1", "人形机器人", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.listMessages
      .mockRejectedValueOnce(new Error("db exploded"))
      .mockResolvedValueOnce([chatMessage("m1", "user", "历史问题")]);
    const { user } = await renderApp(fake);
    await openConversation(user, "人形机器人");

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByText(/db exploded/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.getByText("历史问题")).toBeTruthy());
  });
});
