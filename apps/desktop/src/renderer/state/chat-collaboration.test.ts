import { expect, it } from "vitest";
import { chatReducer, initialChatState, visibleMessages } from "./chat.js";
import type { ChatAgentTask } from "@deepfield/contracts";

it("a child result updates its activity without ending the reply, and stale/other-chat updates cannot replace it", () => {
  let state = chatReducer(initialChatState, { type: "LOAD_START", conversationId: "chat" });
  state = chatReducer(state, { type: "LOAD_SUCCESS", conversationId: "chat", messages: [] });
  state = chatReducer(state, { type: "USER_SUBMIT", content: "分别核查", requestId: "parent" });
  const task: ChatAgentTask = { taskId: "a", runId: "a1", title: "核查一", instruction: "独立验证", status: "completed", sequence: 1, result: "核查结果" };
  const event = { type: "agent_tasks" as const, requestId: "parent", scopeId: "scope", revision: 2, tasks: [task] };
  state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "chat", event });
  expect(state.sending).toBe(true);
  expect(visibleMessages(state).at(-1)).toMatchObject({ status: "streaming", agentTasks: [task] });
  const current = state;
  state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "chat", event: { ...event, revision: 1, tasks: [] } });
  expect(state).toBe(current);
  state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "other", event: { ...event, revision: 3, tasks: [] } });
  expect(visibleMessages(state).at(-1)?.agentTasks).toEqual([task]);
  state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "chat", event: { requestId: "parent", type: "completed", text: "综合结论" } });
  expect(state.sending).toBe(false);
  expect(visibleMessages(state).at(-1)).toMatchObject({ status: "done", content: "综合结论", agentTasks: [task] });
  const completed = state;
  state = chatReducer(state, { type: "WORKER_EVENT", conversationId: "chat", event: { ...event, revision: 4 } });
  expect(state).toBe(completed);
});
