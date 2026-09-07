// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";
import {
  chatMessage,
  makeFakeApi,
  project,
  workerEvent,
  type FakeDesktopApi,
} from "./renderer-test-helpers.js";

const REQUEST_ID = "fixed-req";

async function renderApp(fake: FakeDesktopApi) {
  const user = userEvent.setup();
  const utils = render(<App api={fake} requestIdFactory={() => REQUEST_ID} />);
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

    const input = screen.getByLabelText("消息输入") as HTMLTextAreaElement;
    await user.type(input, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // local user message appears immediately and the composer is disabled
    expect(screen.getByText("你好")).toBeTruthy();
    await waitFor(() => expect(input.disabled).toBe(true));
    expect(fake.chat.send).toHaveBeenCalledWith("p1", "你好", REQUEST_ID, { webSearch: false });

    fake.emit(workerEvent(REQUEST_ID, "started"));
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "测"));
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "试回"));
    fake.emit(workerEvent(REQUEST_ID, "completed", "测试回复"));

    await waitFor(() => expect(screen.getByText("测试回复")).toBeTruthy());
    await waitFor(() => expect(input.disabled).toBe(false));
    await user.type(input, "再问");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("sends one manual Skill request and shows the Skill badge on the reply", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1" })]);
    fake.skills.list.mockResolvedValue([
      {
        name: "structured-brief",
        description: "Turn a topic or rough notes into a concise three-part research brief.",
      },
    ]);
    const { user } = await renderApp(fake);
    await openProjectChat(fake, user);

    const picker = screen.getByLabelText("Skill") as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(2)); // 不使用 Skill + structured-brief

    await user.selectOptions(picker, "structured-brief");
    expect(picker.value).toBe("structured-brief");
    // the selected Skill label is visible before send
    expect(screen.getByText("Skill: structured-brief")).toBeTruthy();

    await user.type(screen.getByLabelText("消息输入"), "整理研究目标");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(fake.chat.send).toHaveBeenCalledWith("p1", "整理研究目标", REQUEST_ID, {
      webSearch: false,
      skillName: "structured-brief",
    });
    // the selector returns to the empty state after send
    await waitFor(() => expect(picker.value).toBe(""));

    // a started event carrying the Skill shows the badge on the assistant draft
    fake.emit({ requestId: REQUEST_ID, type: "started", skillName: "structured-brief" });
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "测"));
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "试回"));
    fake.emit(workerEvent(REQUEST_ID, "completed", "测试回复"));
    await waitFor(() => expect(screen.getByText("测试回复")).toBeTruthy());
    expect(screen.getByText("Skill: structured-brief")).toBeTruthy();
  });

  it("marks a failed request visibly, keeps the user message and restores the composer", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1" })]);
    const { user } = await renderApp(fake);
    await openProjectChat(fake, user);

    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    fake.emit(workerEvent(REQUEST_ID, "started"));
    fake.emit(workerEvent(REQUEST_ID, "failed", "provider_error"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("你好")).toBeTruthy(); // worker failure keeps the persisted user
    await waitFor(() =>
      expect((screen.getByLabelText("消息输入") as HTMLTextAreaElement).disabled).toBe(false),
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
    fake.emit(workerEvent(REQUEST_ID, "started"));
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "早到"));
    await waitFor(() => expect(screen.getByText("早到")).toBeTruthy());
    resolveSend({ requestId: REQUEST_ID });
  });

  it("ignores late deltas after completion", async () => {
    const fake = makeFakeApi();
    fake.projects.list.mockResolvedValue([project({ id: "p1" })]);
    const { user } = await renderApp(fake);
    await openProjectChat(fake, user);

    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    fake.emit(workerEvent(REQUEST_ID, "completed", "最终"));
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "晚到"));

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

    await openProjectChat(fake, user);
    await user.type(screen.getByLabelText("消息输入"), "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));
    fake.emit(workerEvent(REQUEST_ID, "started"));

    // switch to p2
    const p2Button = await screen.findByRole("button", { name: "低空经济" });
    await user.click(p2Button);
    await user.click(screen.getByRole("button", { name: "打开项目 Chat" }));
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "旧项目内容"));

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
