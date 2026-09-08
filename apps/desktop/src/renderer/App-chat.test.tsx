// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";
import {
  chatMessage,
  chatSendResult,
  conversation,
  makeFakeApi,
  workerEvent,
  type FakeDesktopApi,
} from "./renderer-test-helpers.js";

const REQUEST_ID = "fixed-req";

async function renderApp(fake: FakeDesktopApi) {
  const user = userEvent.setup();
  const utils = render(<App api={fake} requestIdFactory={() => REQUEST_ID} />);
  return { user, ...utils };
}

async function chatVisible(): Promise<HTMLTextAreaElement> {
  let input: HTMLTextAreaElement | undefined;
  await waitFor(() => {
    input = screen.getByLabelText("消息输入") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
  });
  return input as HTMLTextAreaElement;
}

describe("app conversation chat", () => {
  it("opens the newest recent Conversation ready to type, switches history and titles a new first message", async () => {
    const fake = makeFakeApi();
    fake.llm.checkConnection.mockResolvedValue("connected");
    const older = conversation("c-older", "旧对话", true);
    const newer = conversation("c-newer", "最近对话", true);
    fake.conversations.openInitial.mockResolvedValue({ active: newer, recent: [newer, older] });
    fake.chat.listMessages.mockImplementation(async (conversationId) =>
      conversationId === newer.id
        ? [
            chatMessage("n1", "user", "新项目问题"),
            chatMessage("n2", "assistant", "新项目回答"),
          ]
        : conversationId === older.id
          ? [chatMessage("o1", "user", "旧对话问题")]
          : [],
    );
    const { user } = await renderApp(fake);

    // The newest recent Conversation is open immediately without selecting a Project.
    await waitFor(() => expect(screen.getByText("新项目回答")).toBeTruthy());
    expect(screen.getByLabelText("DeepSeek 连接状态：已连接")).toBeTruthy();
    expect(screen.queryByText("请先创建或选择一个项目")).toBeNull();
    const input = await chatVisible();
    await user.type(input, "再问一次");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(fake.chat.send).toHaveBeenCalledWith("c-newer", "再问一次", REQUEST_ID, {
      webSearch: false,
    });
    fake.emit(workerEvent(REQUEST_ID, "started"));
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "再"));
    fake.emit(workerEvent(REQUEST_ID, "completed", "再答"));

    // Click the older conversation and observe its own messages.
    await user.click(screen.getByRole("button", { name: "旧对话" }));
    await waitFor(() => expect(screen.getByText("旧对话问题")).toBeTruthy());

    // ＋ 新对话 opens a blank usable Chat with no Project involvement.
    fake.conversations.create.mockResolvedValue(conversation("c-fresh", "新对话", false));
    fake.chat.send.mockResolvedValue(chatSendResult(REQUEST_ID, "c-fresh", "智能标题"));
    fake.chat.listMessages.mockImplementation(async (conversationId) =>
      conversationId === "c-fresh" ? [] : [],
    );
    await user.click(screen.getByRole("button", { name: "＋ 新对话" }));
    await waitFor(() => expect(screen.getByText("还没有消息")).toBeTruthy());
    const blankInput = await chatVisible();
    await user.type(blankInput, "研究目标整理");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(fake.chat.send).toHaveBeenCalledWith("c-fresh", "研究目标整理", REQUEST_ID, {
      webSearch: false,
    });

    // The first-message title appears in the 对话 sidebar after the send resolves.
    await waitFor(() => expect(screen.getByRole("button", { name: "智能标题" })).toBeTruthy());
  });

  it("keeps the ordinary Chat stream path after a selected Skill affects exactly one send", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话一", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.listMessages.mockResolvedValue([chatMessage("m1", "user", "你好")]);
    fake.skills.list.mockResolvedValue([
      {
        name: "structured-brief",
        description: "Turn a topic or rough notes into a concise three-part research brief.",
      },
    ]);
    fake.chat.send.mockResolvedValue(chatSendResult(REQUEST_ID, "c1", "对话一"));
    const { user } = await renderApp(fake);

    const input = await chatVisible();
    const picker = screen.getByLabelText("Skill") as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(2));
    await user.selectOptions(picker, "structured-brief");
    expect(screen.getByText("Skill: structured-brief")).toBeTruthy();

    await user.type(input, "整理研究目标");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(fake.chat.send).toHaveBeenCalledWith("c1", "整理研究目标", REQUEST_ID, {
      webSearch: false,
      skillName: "structured-brief",
    });
    await waitFor(() => expect(picker.value).toBe(""));

    fake.emit({ requestId: REQUEST_ID, type: "started", skillName: "structured-brief" });
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "测"));
    fake.emit(workerEvent(REQUEST_ID, "completed", "测试回复"));
    await waitFor(() => expect(screen.getByText("测试回复")).toBeTruthy());
    expect(screen.getByText("Skill: structured-brief")).toBeTruthy();

    // The next ordinary send carries only the default options.
    fake.chat.send.mockResolvedValue(chatSendResult(REQUEST_ID, "c1", "对话一"));
    const nextInput = await chatVisible();
    await user.type(nextInput, "普通问题");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(fake.chat.send).toHaveBeenCalledWith("c1", "普通问题", REQUEST_ID, {
      webSearch: false,
    });
  });

  it("restores the composer when a send is rejected", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话一", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.listMessages.mockResolvedValue([]);
    fake.chat.send.mockRejectedValue(new Error("deepseek key missing"));
    const { user } = await renderApp(fake);

    const input = await chatVisible();
    await user.type(input, "你好");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect((screen.getByLabelText("消息输入") as HTMLTextAreaElement).value).toBe("你好");
    await waitFor(() =>
      expect((screen.getByLabelText("消息输入") as HTMLTextAreaElement).disabled).toBe(false),
    );
  });
});
