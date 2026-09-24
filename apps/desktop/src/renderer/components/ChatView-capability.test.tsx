// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import { createChatEventHub } from "../state/chat-event-hub.js";
import { conversation, makeFakeApi } from "../renderer-test-helpers.js";
import { ChatView } from "./ChatView.js";

describe("Capability Chat stream", () => {
  it("renders automatic analysis progressively in its own conversation only", async () => {
    const api = makeFakeApi();
    let stream!: (conversationId: string, event: AgentWorkerEvent) => void;
    api.chatCapability = {
      listTasks: vi.fn(async () => []), listConfirmations: vi.fn(async () => []), listOperations: vi.fn(async () => []), listViews: vi.fn(async () => []),
      approve: vi.fn(async () => null), dismiss: vi.fn(async () => true), open: vi.fn(async () => ({ status: "opened" as const })), chooseAnalysis: vi.fn(async () => true),
      setActiveConversation: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      subscribeStream: vi.fn(listener => { stream = listener; return () => {}; }),
    };
    const hub = createChatEventHub();
    const current = conversation("session-a", "A", true);
    render(<ChatView api={api} eventHub={hub} requestIdFactory={() => "user-request"} conversation={current}
      acceptUpdated={() => {}} setWebSearchEnabled={async () => {}} savingWebSearch={false} settingError={undefined} />);
    await waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledWith("session-a"));
    act(() => { stream("session-b", { requestId: "auto-b", type: "started" }); stream("session-b", { requestId: "auto-b", type: "text_delta", delta: "别的会话" }); });
    expect(screen.queryByText("别的会话")).toBeNull();
    act(() => { stream("session-a", { requestId: "auto-a", type: "started" }); stream("session-a", { requestId: "auto-a", type: "text_delta", delta: "分析中" }); });
    expect(await screen.findByText("分析中")).toBeTruthy();
    expect((screen.getByLabelText("消息输入") as HTMLTextAreaElement).disabled).toBe(true);
    act(() => stream("session-a", { requestId: "auto-a", type: "completed", text: "分析完成" }));
    await waitFor(() => expect(api.chat.listMessages).toHaveBeenCalledTimes(2));
    hub.dispose();
  });
});
