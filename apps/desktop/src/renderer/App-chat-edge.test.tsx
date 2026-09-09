// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";
import type { ChatSendResult } from "@deepfield/contracts";
import {
  chatMessage,
  chatSendResult,
  makeFakeApi,
  capabilityItem,
  workerEvent,
  type FakeDesktopApi,
} from "./renderer-test-helpers.js";

const REQUEST_ID = "req-early";

async function renderApp(fake: FakeDesktopApi) {
  const user = userEvent.setup();
  const utils = render(<App api={fake} requestIdFactory={() => REQUEST_ID} />);
  return { user, ...utils };
}

async function openProjectChat(user: ReturnType<typeof userEvent.setup>, label: string) {
  const projectButton = await screen.findByRole("button", { name: label });
  await user.click(projectButton);
  await user.click(screen.getByRole("button", { name: "打开项目 Chat" }));
}

describe("app chat edge cases", () => {
  it("routes early events to the originating project even after switching", async () => {
    const fake = makeFakeApi();
    fake.industryResearch.listItems.mockResolvedValue([
      capabilityItem({ id: "p1", industry: "人形机器人" }),
      capabilityItem({ id: "p2", industry: "低空经济" }),
    ]);
    fake.chat.listMessages.mockImplementation(async (projectId: string) =>
      projectId === "p1"
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
    await openProjectChat(user, "人形机器人");

    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    // events arrive before send resolves while still in p1
    fake.emit(workerEvent(REQUEST_ID, "started"));
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "早"));
    await waitFor(() => expect(screen.getByText("早")).toBeTruthy());

    // switch to p2 before the send resolves
    await openProjectChat(user, "低空经济");
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "串"));
    await waitFor(() => expect(screen.queryByText("串")).toBeNull());
    await waitFor(() => expect(screen.getByText("还没有消息")).toBeTruthy());

    // send resolves; a late completed must not appear in p2
    resolveSend(chatSendResult(REQUEST_ID));
    fake.emit(workerEvent(REQUEST_ID, "completed", "最终"));
    await waitFor(() => expect(screen.queryByText("最终")).toBeNull());

    // back to p1: the persisted final is restored from history
    await openProjectChat(user, "人形机器人");
    await waitFor(() => expect(screen.getByText("最终")).toBeTruthy());
    expect(screen.queryByText("串")).toBeNull();
  });

  it("removes the optimistic user and restores the composer when send is rejected", async () => {
    const fake = makeFakeApi();
    fake.industryResearch.listItems.mockResolvedValue([capabilityItem({ id: "p1" })]);
    fake.chat.send.mockRejectedValue(new Error("deepseek key missing"));
    const { user } = await renderApp(fake);
    await openProjectChat(user, "人形机器人");

    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    // the optimistic user is removed (not persisted) and the composer keeps the text
    await waitFor(() => expect(document.querySelector(".message.user")).toBeNull());
    expect((screen.getByLabelText("消息输入") as HTMLTextAreaElement).value).toBe("你好");
  });

  it("treats a mismatched returned request id as a protocol error and cleans up", async () => {
    const fake = makeFakeApi();
    fake.industryResearch.listItems.mockResolvedValue([capabilityItem({ id: "p1" })]);
    fake.chat.send.mockResolvedValue(chatSendResult("different-id"));
    const { user } = await renderApp(fake);
    await openProjectChat(user, "人形机器人");

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
    fake.industryResearch.listItems.mockResolvedValue([capabilityItem({ id: "p1" })]);
    fake.chat.listMessages
      .mockRejectedValueOnce(new Error("db exploded"))
      .mockResolvedValueOnce([chatMessage("m1", "user", "历史问题")]);
    const { user } = await renderApp(fake);
    await openProjectChat(user, "人形机器人");

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByText(/db exploded/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.getByText("历史问题")).toBeTruthy());
  });
});
