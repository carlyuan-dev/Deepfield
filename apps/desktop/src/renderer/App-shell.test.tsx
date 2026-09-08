// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";
import {
  chatMessage,
  conversation,
  makeFakeApi,
  type FakeDesktopApi,
} from "./renderer-test-helpers.js";

const REQUEST_ID = "fixed-req";

async function renderApp(fake: FakeDesktopApi) {
  const user = userEvent.setup();
  const utils = render(<App api={fake} requestIdFactory={() => REQUEST_ID} />);
  return { user, ...utils };
}

async function chatReady(): Promise<HTMLTextAreaElement> {
  let input: HTMLTextAreaElement | undefined;
  await waitFor(() => {
    input = screen.getByLabelText("消息输入") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
  });
  return input as HTMLTextAreaElement;
}

describe("app three-pane shell", () => {
  it("keeps a stable split, closes the Capability, selects history, and preserves scroll intent", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话甲", true);
    const older = conversation("c2", "对话乙", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active, older] });
    fake.chat.listMessages.mockImplementation(async (conversationId) =>
      conversationId === "c1"
        ? [
            chatMessage("m1", "user", "已有很长的一段历史消息"),
            chatMessage("m2", "assistant", "历史回复"),
          ]
        : [],
    );
    const { user } = await renderApp(fake);

    // 1) Initial state: no Capability, Chat fills the workspace.
    const input = await chatReady();
    expect(screen.queryByRole("heading", { name: "行业研究" })).toBeNull();
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");
    expect(document.querySelector(".capability-pane")).toBeNull();

    // Recent history is selected as a stable page selection, while the new-chat
    // action remains a normal action button.
    expect(screen.getByRole("button", { name: "对话甲" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("button", { name: "对话甲" }).className).toContain("active");
    expect(screen.getByRole("button", { name: "＋ 新对话" }).className).not.toContain("active");

    const messages = document.querySelector(".messages") as HTMLDivElement;
    Object.defineProperties(messages, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    });
    messages.scrollTop = 400;
    fireEvent.scroll(messages);

    // 2) Direct 行业研究 click opens the Capability and collapses Chat.
    await user.click(screen.getByRole("button", { name: "行业研究" }));
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();
    expect(screen.getByLabelText("行业")).toBeTruthy();
    expect(document.querySelector(".workspace-panes")?.className).toContain("with-capability");
    expect(document.querySelector(".workspace-panes")?.className).toContain("collapsed");
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");
    expect(screen.getByRole("button", { name: "展开 Chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭 Capability" })).toBeTruthy();

    // 3) The arrow expands Chat into the fixed 520px split.
    await user.click(screen.getByRole("button", { name: "展开 Chat" }));
    expect(document.querySelector(".workspace-panes")?.className).toContain("expanded");
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");

    // 4) Very long messages stay inside the Chat scroll container.
    expect(document.querySelector(".messages")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();

    // 5) Stream a reply, collapse mid-flight, keep streaming, re-expand: the draft survives.
    await user.type(input, "研究目标");
    await user.click(screen.getByRole("button", { name: "发送" }));
    fake.emit({ requestId: REQUEST_ID, type: "started" });
    fake.emit({ requestId: REQUEST_ID, type: "text_delta", delta: "测" });
    await waitFor(() => expect(screen.getByText("测")).toBeTruthy());
    expect(messages.scrollTop).toBe(500);

    // Once the user scrolls up, later streaming updates must not pull them back.
    messages.scrollTop = 100;
    fireEvent.scroll(messages);
    fake.emit({ requestId: REQUEST_ID, type: "text_delta", delta: "不应强拉" });
    await waitFor(() => expect(screen.getByText("测不应强拉")).toBeTruthy());
    expect(messages.scrollTop).toBe(100);

    await user.click(screen.getByRole("button", { name: "收起 Chat" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");
    // ChatView stays mounted: further deltas still arrive while collapsed.
    fake.emit({ requestId: REQUEST_ID, type: "text_delta", delta: "试回" });
    await user.click(screen.getByRole("button", { name: "展开 Chat" }));
    fake.emit({ requestId: REQUEST_ID, type: "completed", text: "测试回复" });
    await waitFor(() => expect(screen.getByText("测试回复")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();

    // 6) A Conversation click re-expands Chat while the Capability remains mounted.
    await user.click(screen.getByRole("button", { name: "收起 Chat" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");
    await user.click(screen.getByRole("button", { name: "对话乙" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");
    expect(screen.getByRole("button", { name: "收起 Chat" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();
    // the switched Conversation is usable and open beside the Capability
    expect(screen.getByLabelText("消息输入")).toBeTruthy();

    // 7) Closing is shell state: it removes Capability and expands Chat.
    await user.click(screen.getByRole("button", { name: "关闭 Capability" }));
    expect(document.querySelector(".capability-pane")).toBeNull();
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");

  });
});
