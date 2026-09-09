import { describe, expect, it } from "vitest";
import type { AgentWorkerEvent, ChatMessage, ConversationId, MessageId } from "@deepfield/contracts";
import {
  chatReducer,
  initialChatState,
  visibleMessages,
  type ChatState,
} from "./chat.js";

function event(
  requestId: string,
  type: Exclude<AgentWorkerEvent["type"], "tool_activity">,
  payload?: string,
): AgentWorkerEvent {
  switch (type) {
    case "started":
      return { requestId, type: "started" };
    case "text_delta":
      return { requestId, type: "text_delta", delta: payload ?? "" };
    case "completed":
      return { requestId, type: "completed", text: payload ?? "" };
    case "failed":
      return { requestId, type: "failed", code: payload ?? "error", message: "boom" };
  }
}

function loadedConversation(conversationId: string, history: ChatMessage[] = []): ChatState {
  let state = chatReducer(initialChatState, { type: "LOAD_START", conversationId });
  state = chatReducer(state, { type: "LOAD_SUCCESS", conversationId, messages: history });
  return state;
}

const persisted = (id: string, role: "user" | "assistant", content: string): ChatMessage => ({
  id: id as MessageId,
  conversationId: "c1" as ConversationId,
  role,
  content,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("chat reducer", () => {
  it("loads history and renders it as done messages", () => {
    const state = loadedConversation("c1", [
      persisted("m1", "user", "a"),
      persisted("m2", "assistant", "b"),
    ]);
    expect(state.loadState).toBe("ready");
    expect(state.messages.map((message) => message.content)).toEqual(["a", "b"]);
    expect(visibleMessages(state).map((message) => message.content)).toEqual(["a", "b"]);
  });

  it("appends the local user message immediately with a pending marker and disables sending", () => {
    const state = chatReducer(loadedConversation("c1"), {
      type: "USER_SUBMIT",
      content: "你好",
      requestId: "r1",
    });
    expect(state.sending).toBe(true);
    expect(state.messages.at(-1)).toMatchObject({
      role: "user",
      content: "你好",
      requestId: "r1",
      pending: true,
    });
  });

  it("removes the pending user message when the send is rejected", () => {
    let state = chatReducer(loadedConversation("c1"), {
      type: "USER_SUBMIT",
      content: "你好",
      requestId: "r1",
    });
    state = chatReducer(state, { type: "SEND_ERROR", requestId: "r1", error: "发送失败，请重试" });
    expect(state.sending).toBe(false);
    expect(state.sendError).toBe("发送失败，请重试");
    expect(
      state.messages.some((message) => message.role === "user" && message.content === "你好"),
    ).toBe(false);
  });

  it("marks the pending user as persisted once worker events arrive", () => {
    let state = chatReducer(loadedConversation("c1"), {
      type: "USER_SUBMIT",
      content: "你好",
      requestId: "r1",
    });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r1", "started"),
    });
    expect(state.messages[state.messages.length - 1]).toMatchObject({ pending: false });
  });

  it("keeps the user message when the worker reports failure", () => {
    let state = chatReducer(loadedConversation("c1"), {
      type: "USER_SUBMIT",
      content: "你好",
      requestId: "r1",
    });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r1", "failed", "provider_error"),
    });
    expect(
      state.messages.some((message) => message.role === "user" && message.content === "你好"),
    ).toBe(true);
  });

  it("builds a draft from started and appends deltas in order", () => {
    let state = chatReducer(loadedConversation("c1"), {
      type: "USER_SUBMIT",
      content: "你好",
      requestId: "r1",
    });
    state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "c1", event: event("r1", "started") });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r1", "text_delta", "测"),
    });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r1", "text_delta", "试回"),
    });
    expect(state.drafts["r1"]).toMatchObject({ status: "streaming", content: "测试回" });
    expect(visibleMessages(state).at(-1)).toMatchObject({ role: "assistant", content: "测试回" });
  });

  it("finalizes the completed draft in place and restores sending", () => {
    let state = chatReducer(loadedConversation("c1"), {
      type: "USER_SUBMIT",
      content: "你好",
      requestId: "r1",
    });
    state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "c1", event: event("r1", "started") });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r1", "completed", "测试回复"),
    });
    expect(state.drafts["r1"]).toBeUndefined();
    expect(visibleMessages(state).map((message) => message.content)).toEqual(["你好", "测试回复"]);
    expect(state.sending).toBe(false);
  });

  it("finalizes a failed reply in place and restores sending without a final text", () => {
    let state = chatReducer(loadedConversation("c1"), {
      type: "USER_SUBMIT",
      content: "你好",
      requestId: "r1",
    });
    state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "c1", event: event("r1", "started") });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r1", "failed", "provider_error"),
    });
    expect(state.drafts["r1"]).toBeUndefined();
    expect(visibleMessages(state)).toMatchObject([
      { role: "user", content: "你好" },
      { role: "assistant", status: "failed", content: "" },
    ]);
    expect(state.sending).toBe(false);
  });

  it("ignores late deltas after completion", () => {
    let state = chatReducer(loadedConversation("c1"), {
      type: "USER_SUBMIT",
      content: "你好",
      requestId: "r1",
    });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r1", "completed", "最终"),
    });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r1", "text_delta", "晚到"),
    });
    expect(state.drafts["r1"]).toBeUndefined();
    expect(visibleMessages(state).map((message) => message.content)).toEqual(["你好", "最终"]);
  });

  it("applies events before the send promise resolves via the request id", () => {
    let state = loadedConversation("c1");
    state = chatReducer(state, { type: "USER_SUBMIT", content: "你好", requestId: "r1" });
    state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "c1", event: event("r1", "started") });
    expect(state.drafts["r1"]).toMatchObject({ status: "streaming", content: "" });
  });

  it("ignores events from other conversations", () => {
    let state = loadedConversation("c2");
    state = chatReducer(state, { type: "USER_SUBMIT", content: "你好", requestId: "r1" });
    const before = state;
    state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "c1", event: event("r1", "started") });
    expect(state.drafts).toEqual(before.drafts);
    expect(state.drafts["r1"]).toBeUndefined();
  });

  it("keeps three sequential user and assistant turns interleaved without a reload", () => {
    let state = loadedConversation("c1");
    const submitTurn = (requestId: string, question: string, answer: string): void => {
      state = chatReducer(state, {
        type: "USER_SUBMIT",
        content: question,
        requestId,
      });
      state = chatReducer(state, {
        type: "WORKER_EVENT",
        conversationId: "c1",
        event: event(requestId, "started"),
      });
      state = chatReducer(state, {
        type: "WORKER_EVENT",
        conversationId: "c1",
        event: event(requestId, "completed", answer),
      });
    };

    submitTurn("r1", "user1", "assistant1");
    submitTurn("r2", "user2", "assistant2");
    submitTurn("r3", "user3", "assistant3");

    expect(visibleMessages(state).map((message) => message.content)).toEqual([
      "user1",
      "assistant1",
      "user2",
      "assistant2",
      "user3",
      "assistant3",
    ]);
  });

  it("keeps a failed reply in place before the next user turn", () => {
    let state = loadedConversation("c1");
    state = chatReducer(state, { type: "USER_SUBMIT", content: "user1", requestId: "r1" });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r1", "failed", "provider_error"),
    });
    state = chatReducer(state, { type: "USER_SUBMIT", content: "user2", requestId: "r2" });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r2", "completed", "assistant2"),
    });

    expect(visibleMessages(state).map((message) => [message.role, message.status, message.content])).toEqual([
      ["user", "done", "user1"],
      ["assistant", "failed", ""],
      ["user", "done", "user2"],
      ["assistant", "done", "assistant2"],
    ]);
  });

  it("keeps other-conversation drafts out of the current conversation render", () => {
    let state = loadedConversation("c1");
    state = chatReducer(state, { type: "USER_SUBMIT", content: "你好", requestId: "r1" });
    state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "c1", event: event("r1", "started") });
    state = chatReducer(state, {
      type: "WORKER_EVENT",
      conversationId: "c1",
      event: event("r1", "text_delta", "旧"),
    });
    state = chatReducer(state, { type: "LOAD_START", conversationId: "c2" });
    expect(visibleMessages(state).length).toBe(0);
  });

  it("ignores stale history loads from a previous conversation", () => {
    let state = chatReducer(initialChatState, { type: "LOAD_START", conversationId: "c2" });
    state = chatReducer(state, {
      type: "LOAD_SUCCESS",
      conversationId: "c1",
      messages: [persisted("m1", "user", "stale")],
    });
    expect(state.messages).toEqual([]);
    state = chatReducer(state, {
      type: "LOAD_SUCCESS",
      conversationId: "c2",
      messages: [persisted("m2", "assistant", "fresh")],
    });
    expect(state.messages.map((message) => message.content)).toEqual(["fresh"]);
  });

  it("surfaces load errors visibly", () => {
    let state = chatReducer(initialChatState, { type: "LOAD_START", conversationId: "c1" });
    state = chatReducer(state, { type: "LOAD_ERROR", conversationId: "c1", error: "加载消息失败" });
    expect(state.loadState).toBe("error");
    expect(state.loadError).toBe("加载消息失败");
  });

  it("reset clears the session state", () => {
    const state = chatReducer(loadedConversation("c1"), { type: "RESET" });
    expect(state.conversationId).toBeUndefined();
    expect(state.messages).toEqual([]);
    expect(state.sending).toBe(false);
  });
});
