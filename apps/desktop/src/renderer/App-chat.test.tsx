// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
const connectionView = (connected: boolean) => ({ schemaVersion: 1 as const, llm: { activeProfileId: connected ? "l1" : null, profiles: connected ? [{ id: "l1", name: "Model", provider: "custom" as const, protocol: "openai_compatible" as const, baseUrl: "https://llm.test", modelId: "m", contextWindow: 32000, hasCredential: true }] : [] }, search: { activeProfileId: null, profiles: [], manifests: [] } });

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
  it("rechecks a stale disconnected indicator when the window regains focus", async () => {
    const fake = makeFakeApi();
    fake.settings.get.mockResolvedValueOnce(connectionView(false)).mockResolvedValueOnce(connectionView(true));
    render(<App api={fake} requestIdFactory={() => REQUEST_ID} />);

    expect(await screen.findByLabelText("模型连接状态：未连接")).toBeTruthy();
    act(() => window.dispatchEvent(new Event("focus")));

    expect(await screen.findByLabelText("模型连接状态：已连接")).toBeTruthy();
    expect(fake.settings.get).toHaveBeenCalledTimes(2);
  });

  it("ignores an older connection result that finishes after a newer successful check", async () => {
    const fake = makeFakeApi();
    let resolveInitial!: () => void;
    fake.settings.get.mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = () => resolve(connectionView(false)); })).mockResolvedValueOnce(connectionView(true));
    render(<App api={fake} requestIdFactory={() => REQUEST_ID} />);

    act(() => window.dispatchEvent(new Event("focus")));
    expect(await screen.findByLabelText("模型连接状态：已连接")).toBeTruthy();
    await act(async () => resolveInitial());

    expect(screen.getByLabelText("模型连接状态：已连接")).toBeTruthy();
  });

  it("opens the newest recent Conversation ready to type, switches history and titles a new first message", async () => {
    const fake = makeFakeApi();
    fake.settings.get.mockResolvedValue(connectionView(true));
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
    expect(screen.getByLabelText("模型连接状态：已连接")).toBeTruthy();
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

  it("sends with web search enabled and renders returned source urls as links", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话一", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.listMessages.mockResolvedValue([]);
    fake.chat.send.mockResolvedValue(chatSendResult(REQUEST_ID, "c1", "对话一"));
    const { user } = await renderApp(fake);

    const input = await chatVisible();
    const toggle = screen.getByRole("button", { name: "联网搜索" });
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await user.type(input, "搜索近期进展");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(fake.chat.send).toHaveBeenCalledWith("c1", "搜索近期进展", REQUEST_ID, {
      webSearch: true,
    });

    fake.emit({ requestId: REQUEST_ID, type: "started", webSearch: true });
    fake.emit(workerEvent(REQUEST_ID, "text_delta", "来源：https://example.com/report"));
    fake.emit(workerEvent(REQUEST_ID, "completed", "来源：https://example.com/report"));

    const link = await screen.findByRole("link", { name: "https://example.com/report" });
    expect(link.getAttribute("href")).toBe("https://example.com/report");
    expect(screen.getByText("联网搜索", { selector: ".web-search-badge" })).toBeTruthy();
  });

  it("expands ordered tool activity while running and collapses it on completion", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话一", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active] });
    fake.chat.listMessages.mockResolvedValue([]);
    fake.chat.send.mockResolvedValue(chatSendResult(REQUEST_ID, "c1", "对话一"));
    const { user } = await renderApp(fake);

    const input = await chatVisible();
    await user.type(input, "查资料");
    await user.click(screen.getByRole("button", { name: "发送" }));
    act(() => {
      fake.emit(workerEvent(REQUEST_ID, "started"));
      fake.emit({
        requestId: REQUEST_ID,
        type: "tool_activity",
        callKey: "activity-1",
        name: "fetch_url",
        status: "running",
        summary: "example.com",
      });
      fake.emit({
        requestId: REQUEST_ID,
        type: "tool_activity",
        callKey: "activity-2",
        name: "calculator",
        status: "running",
        summary: "2 + 2",
      });
    });

    const runningToggle = await screen.findByRole("button", { name: "正在调用 2 个工具" });
    expect(runningToggle.getAttribute("aria-expanded")).toBe("true");
    expect(runningToggle.querySelector(".tool-activity-arrow")?.textContent).toBe("↑");
    expect(screen.getByText("读取网页")).toBeTruthy();
    expect(screen.getByText("计算器")).toBeTruthy();
    expect(screen.getAllByText("调用中")).toHaveLength(2);
    expect(
      within(screen.getByLabelText("工具调用"))
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["读取网页example.com调用中", "计算器2 + 2调用中"]);

    act(() => {
      fake.emit({
        requestId: REQUEST_ID,
        type: "tool_activity",
        callKey: "activity-1",
        name: "fetch_url",
        status: "completed",
        summary: "example.com",
      });
      fake.emit({
        requestId: REQUEST_ID,
        type: "tool_activity",
        callKey: "activity-2",
        name: "calculator",
        status: "failed",
        summary: "2 + 2",
      });
      fake.emit(workerEvent(REQUEST_ID, "completed", "完成"));
    });

    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "已调用 2 个工具" })
          .getAttribute("aria-expanded"),
      ).toBe("false"),
    );
    const completedToggle = screen.getByRole("button", { name: "已调用 2 个工具" });
    expect(completedToggle.querySelector(".tool-activity-arrow")?.textContent).toBe("↓");
    expect(screen.queryByText("example.com")).toBeNull();

    await user.click(completedToggle);
    expect(completedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(completedToggle.querySelector(".tool-activity-arrow")?.textContent).toBe("↑");
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByText("已完成")).toBeTruthy();
    expect(screen.getByText("调用失败")).toBeTruthy();
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
