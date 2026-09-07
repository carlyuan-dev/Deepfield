// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "./App.js";
import {
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
  it("keeps the Chat pane mounted through capability open, expand, streaming collapse and conversation clicks", async () => {
    const fake = makeFakeApi();
    const active = conversation("c1", "对话甲", true);
    const older = conversation("c2", "对话乙", true);
    fake.conversations.openInitial.mockResolvedValue({ active, recent: [active, older] });
    fake.chat.listMessages.mockImplementation(async (conversationId) =>
      conversationId === "c1" ? [] : [],
    );
    const { user } = await renderApp(fake);

    // 1) Initial state: no Capability, Chat fills the workspace.
    const input = await chatReady();
    expect(screen.queryByRole("heading", { name: "行业研究" })).toBeNull();
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");
    expect(document.querySelector(".capability-pane")).toBeNull();

    // 2) Direct 行业研究 click opens the Capability and collapses Chat to a narrow rail.
    await user.click(screen.getByRole("button", { name: "行业研究" }));
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();
    expect(screen.getByLabelText("行业")).toBeTruthy();
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");
    expect(screen.getByRole("button", { name: "展开 Chat" })).toBeTruthy();

    // 3) The arrow expands Chat beside the Capability; the Capability stays mounted.
    await user.click(screen.getByRole("button", { name: "展开 Chat" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");
    expect(screen.getByRole("button", { name: "收起 Chat" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();

    // 4) Stream a reply, collapse mid-flight, keep streaming, re-expand: the draft survives.
    await user.type(input, "研究目标");
    await user.click(screen.getByRole("button", { name: "发送" }));
    fake.emit({ requestId: REQUEST_ID, type: "started" });
    fake.emit({ requestId: REQUEST_ID, type: "text_delta", delta: "测" });
    await waitFor(() => expect(screen.getByText("测")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "收起 Chat" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");
    // ChatView stays mounted: further deltas still arrive while collapsed.
    fake.emit({ requestId: REQUEST_ID, type: "text_delta", delta: "试回" });
    await user.click(screen.getByRole("button", { name: "展开 Chat" }));
    fake.emit({ requestId: REQUEST_ID, type: "completed", text: "测试回复" });
    await waitFor(() => expect(screen.getByText("测试回复")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();

    // 5) A Conversation click re-expands Chat while the Capability remains mounted.
    await user.click(screen.getByRole("button", { name: "收起 Chat" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("collapsed");
    await user.click(screen.getByRole("button", { name: "对话乙" }));
    expect(document.querySelector(".chat-pane")?.className).toContain("expanded");
    expect(screen.getByRole("button", { name: "收起 Chat" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "行业研究" })).toBeTruthy();
    // the switched Conversation is usable and open beside the Capability
    expect(screen.getByLabelText("消息输入")).toBeTruthy();
  });
});
