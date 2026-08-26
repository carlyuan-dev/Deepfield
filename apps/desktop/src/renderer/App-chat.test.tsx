// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";import {
  chatMessage,
  makeFakeApi,
  project,
  workerEvent,
  type FakeDesktopApi,
} from "./renderer-test-helpers.js";

async function renderApp(fake: FakeDesktopApi) {
  const user = userEvent.setup();
  const utils = render(<App api={fake} />);
  return { user, ...utils };
}

async function openProjectChat(fake: FakeDesktopApi, user: ReturnType<typeof userEvent.setup>) {
  const projectButton = await screen.findByRole("button", { name: "人形机器人" });
  await user.click(projectButton);
  await user.click(screen.getByRole("button", { name: "打开项目 Chat" }));
}

describe("app chat", () => {
  it("streams a full conversation from submit to completion", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1" })]);
    const { user } = await renderApp(fake);
    await openProjectChat(fake, user);

    const input = screen.getByLabelText("消息输入");
    await user.type(input, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // local user message appears immediately; typing more keeps the send
    // button disabled while the request is in flight
    expect(screen.getByText("你好")).toBeTruthy();
    await user.type(input, "追加");
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);

    const requestId = "req-stream-1";
    fake.emit(workerEvent(requestId, "started"));
    fake.emit(workerEvent(requestId, "text_delta", "测"));
    fake.emit(workerEvent(requestId, "text_delta", "试回"));
    fake.emit(workerEvent(requestId, "completed", "测试回复"));

    await waitFor(() => expect(screen.getByText("测试回复")).toBeTruthy());
    await user.type(screen.getByLabelText("消息输入"), "再问");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(fake.chat.send).toHaveBeenCalledWith("p1", "你好");
  });

  it("marks a failed request visibly and restores the composer", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1" })]);
    const { user } = await renderApp(fake);
    await openProjectChat(fake, user);

    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    fake.emit(workerEvent("req-fail", "started"));
    fake.emit(workerEvent("req-fail", "failed", "provider_error"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    await user.type(screen.getByLabelText("消息输入"), "再问");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("handles events that arrive before the send promise resolves", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1" })]);
    let resolveSend!: (value: { requestId: string }) => void;
    fake.chat.send.mockImplementation(
      () =>
        new Promise<{ requestId: string }>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { user } = await renderApp(fake);
    await openProjectChat(fake, user);

    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    // event arrives before send() resolves
    fake.emit(workerEvent("req-early", "started"));
    fake.emit(workerEvent("req-early", "text_delta", "早到"));
    await waitFor(() => expect(screen.getByText("早到")).toBeTruthy());
    resolveSend({ requestId: "req-early" });
  });

  it("ignores late deltas after completion", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1" })]);
    const { user } = await renderApp(fake);
    await openProjectChat(fake, user);

    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    fake.emit(workerEvent("req-late", "completed", "最终"));
    fake.emit(workerEvent("req-late", "text_delta", "晚到"));

    await waitFor(() => expect(screen.getByText("最终")).toBeTruthy());
    expect(screen.queryByText(/最终晚到/)).toBeNull();
  });

  it("keeps old-project events out of the current project", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([
      project({ id: "p1", industry: "人形机器人" }),
      project({ id: "p2", industry: "低空经济" }),
    ]);
    const { user } = await renderApp(fake);

    // start a request in p1 and use its real request id for the event stream
    await openProjectChat(fake, user);
    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    const sendResult = await fake.chat.send.mock.results[0]!.value;
    const requestId = sendResult.requestId;
    fake.emit(workerEvent(requestId, "started"));

    // switch to p2
    const p2Button = await screen.findByRole("button", { name: "低空经济" });
    await user.click(p2Button);
    await user.click(screen.getByRole("button", { name: "打开项目 Chat" }));
    fake.emit(workerEvent(requestId, "text_delta", "旧项目内容"));

    await waitFor(() => expect(screen.queryByText("旧项目内容")).toBeNull());
    await waitFor(() => expect(screen.getByText("还没有消息")).toBeTruthy());
  });

  it("loads persisted history for the opened project", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1" })]);
    fake.chat.listMessages.mockResolvedValue([
      chatMessage("m1", "user", "历史问题"),
      chatMessage("m2", "assistant", "历史回答"),
    ]);
    const { user } = await renderApp(fake);
    await openProjectChat(fake, user);

    await waitFor(() => expect(screen.getByText("历史问题")).toBeTruthy());
    expect(screen.getByText("历史回答")).toBeTruthy();
    expect(fake.chat.listMessages).toHaveBeenCalledWith("p1");
  });
});
