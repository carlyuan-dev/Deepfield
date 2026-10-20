// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DesktopApi, InteractionRecord } from "@deepfield/contracts";
import { createChatEventHub } from "../state/chat-event-hub.js";
import { conversation, makeFakeApi } from "../renderer-test-helpers.js";
import { ChatView } from "./ChatView.js";

const question: InteractionRecord = {
  id: "i-old", conversationId: "old", requestId: "r-old", toolCallId: "tool-old", revision: 1,
  status: "waiting", createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z",
  payload: { kind: "question", question: "旧会话的问题？", options: [{ id: "yes", label: "是" }] },
};

describe("ChatView interaction ownership", () => {
  it("follows content resize, preserves reading position and resets follow on send and conversation change", async () => {
    let resized = () => {};
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    try {
      const api = makeFakeApi();
      const hub = createChatEventHub();
      const props = { api, eventHub: hub, requestIdFactory: () => "resize-request",
        acceptUpdated: () => {}, setWebSearchEnabled: async () => {}, savingWebSearch: false, settingError: undefined };
      const view = render(<ChatView {...props} conversation={conversation("old")} />);
      await waitFor(() => expect(view.container.querySelector(".messages")).toBeTruthy());
      const list = view.container.querySelector(".messages") as HTMLDivElement;
      let height = 600;
      Object.defineProperties(list, {
        clientHeight: { configurable: true, value: 200 },
        scrollHeight: { configurable: true, get: () => height },
      });
      act(() => resized());
      expect(list.scrollTop).toBe(600);
      list.scrollTop = 150;
      fireEvent.scroll(list);
      height = 900;
      act(() => resized());
      expect(list.scrollTop).toBe(150);
      fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
      expect(list.scrollTop).toBe(900);
      list.scrollTop = 150;
      fireEvent.scroll(list);
      fireEvent.change(screen.getByLabelText("消息输入"), { target: { value: "新消息" } });
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      expect(list.scrollTop).toBe(900);
      list.scrollTop = 150;
      fireEvent.scroll(list);
      view.rerender(<ChatView {...props} conversation={conversation("new")} />);
      await waitFor(() => expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull());
      hub.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("offers a newly arrived approval for one automatic editor open but never reopens history", async () => {
    const api = makeFakeApi();
    const onNewInteraction = vi.fn();
    const listeners = new Set<(id: string) => void>();
    const approval: InteractionRecord = { ...question, id: "new-approval", payload: { kind: "approval", summary: "创建主题",
      operation: { provider: "company", operationId: "create", contractVersion: "1", draftRef: JSON.stringify({ capabilityId: "company", draftId: "d1", revision: "1" }) } } };
    let interactions = [question];
    api.chat.listInteractions.mockImplementation(async () => interactions);
    api.chat.onInteractions.mockImplementation(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; });
    const hub = createChatEventHub();
    render(<ChatView api={api} eventHub={hub} requestIdFactory={() => "r-new"} conversation={conversation("old")}
      acceptUpdated={() => {}} setWebSearchEnabled={async () => {}} savingWebSearch={false} settingError={undefined}
      onNewInteraction={onNewInteraction} />);
    await waitFor(() => expect(api.chat.listInteractions).toHaveBeenCalledWith("old"));
    expect(onNewInteraction).not.toHaveBeenCalled();
    interactions = [question, approval];
    for (const listener of listeners) listener("old");
    await waitFor(() => expect(onNewInteraction).toHaveBeenCalledWith(approval));
    for (const listener of listeners) listener("old");
    await waitFor(() => expect(api.chat.listInteractions).toHaveBeenCalledTimes(3));
    expect(onNewInteraction).toHaveBeenCalledTimes(1);
    hub.dispose();
  });
  it("does not show a late old-conversation response in the newly selected conversation", async () => {
    const api = makeFakeApi();
    api.chat.listMessages.mockImplementation(async id => id === "old" ? [{ id: "m-old" as never, conversationId: "old" as never,
      role: "user", content: "旧请求", requestId: "r-old", createdAt: "2026-09-23T00:00:00Z" }] : []);
    let finish!: (record: InteractionRecord) => void;
    const respond = vi.fn(() => new Promise<InteractionRecord>(resolve => { finish = resolve; }));
    Object.assign(api.chat, {
      listInteractions: vi.fn(async (id: string) => id === "old" ? [question] : []),
      respondInteraction: respond,
      onInteractions: vi.fn(() => () => {}),
    });
    const hub = createChatEventHub();
    const props = { api: api as DesktopApi, eventHub: hub, requestIdFactory: () => "new-request",
      acceptUpdated: () => {}, setWebSearchEnabled: async () => {}, savingWebSearch: false, settingError: undefined };
    const view = render(<ChatView {...props} conversation={conversation("old")} />);
    await screen.findByText("旧会话的问题？");
    fireEvent.click(screen.getByLabelText("是"));
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("old", { interactionId: "i-old", expectedRevision: 1, response: { kind: "answer", text: "是" } }));
    view.rerender(<ChatView {...props} conversation={conversation("new")} />);
    finish({ ...question, status: "answered", answer: "yes" });
    await waitFor(() => expect(screen.queryByText("旧会话的问题？")).toBeNull());
    hub.dispose();
  });
});
