import { afterEach, expect, it, vi } from "vitest";
import { openTestDb, type TestDb } from "../../testing/application-test-helpers.js";
import { ChatInteractionCoordinator } from "./coordinator.js";
import { ChatService } from "../chat-service.js";
import { ContextBuilder } from "../context-builder.js";
import { FakeWorker, makeSecrets } from "../chat-service-helpers.js";
import type { AgentWorkerEvent, AgentWorkerRequest, InteractionRecord } from "@deepfield/contracts";
const dbs: TestDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.cleanup(); });
it("does not persist a tool preamble that the worker retracted before handoff", async () => {
  const db = openTestDb(); dbs.push(db); const conversation = db.repos.conversations.create();
  const worker = new FakeWorker({ events: request => [
    { requestId: request.requestId, type: "text_delta", delta: "I'll add those companies." },
    { requestId: request.requestId, type: "text_reset" },
    { requestId: request.requestId, type: "tool_activity", callKey: "offer", name: "propose_actions", status: "completed" },
    { requestId: request.requestId, type: "handed_off" },
  ] });
  const service = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("key"), worker);
  await service.send(conversation.id, "加入这些公司", "r", () => {});
  await vi.waitFor(() => expect(db.repos.chatSessions.list(conversation.id)[0]?.awaitingUser).toBe(true));
  expect(service.listMessages(conversation.id).at(-1)?.content).toBe("");
  service.dispose();
});

it("holds receipt resumption while the next approval is waiting", async () => {
  const db = openTestDb(); dbs.push(db); const conversation = db.repos.conversations.create();
  const coordinator = new ChatInteractionCoordinator(db.repos.chatInteractions, new Map());
  const first = await coordinator.create({ conversationId: conversation.id, requestId: "r", toolCallId: "a" }, { kind: "question", question: "A?" });
  await coordinator.respond({ interactionId: first.id, expectedRevision: 1, response: { kind: "answer", text: "A" } }, { conversationId: conversation.id, source: "chat_button" });
  await coordinator.create({ conversationId: conversation.id, requestId: "r", toolCallId: "b" }, { kind: "question", question: "B?" });
  const worker = new FakeWorker(); const profiles = makeSecrets("key");
  const service = new ChatService(db.repos, new ContextBuilder(db.repos), profiles, worker, { interactions: coordinator });
  service.interactionChanged(conversation.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(worker.requests).toHaveLength(0); expect(profiles.getCalls).toBe(0);
  expect(db.repos.chatInteractions.pendingEvents()).toHaveLength(1);
  service.dispose();
});
it("reloads the actual initial handoff text and tool activity without a fabricated final answer", async () => {
  const db = openTestDb(); dbs.push(db); const conversation = db.repos.conversations.create();
  const worker = new FakeWorker({ events: request => [
    { requestId: request.requestId, type: "text_delta", delta: "请先" },
    { requestId: request.requestId, type: "text_delta", delta: "选择范围。" },
    { requestId: request.requestId, type: "tool_activity", callKey: "ask", name: "request_user_input", status: "completed" },
    { requestId: request.requestId, type: "handed_off" },
  ] });
  const service = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("key"), worker);
  await service.send(conversation.id, "start", "initial-wait", () => {});
  await vi.waitFor(() => expect(db.repos.chatSessions.list(conversation.id)[0]?.awaitingUser).toBe(true));
  const reloaded = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("key"), worker);
  expect(reloaded.listMessages(conversation.id).find(message => message.role === "assistant" && message.requestId === "initial-wait"))
    .toMatchObject({ content: "请先选择范围。", toolExecutions: [{ name: "request_user_input", status: "completed" }] });
  expect(db.repos.chatSessions.list(conversation.id)[0]?.completed).toBe(false);
  service.dispose(); reloaded.dispose();
});

it("anchors an empty automatic question turn and drains its answer arriving before handoff", async () => {
  const db = openTestDb(); dbs.push(db); const conversation = db.repos.conversations.create();
  const coordinator = new ChatInteractionCoordinator(db.repos.chatInteractions, new Map());
  const first = await coordinator.create({ conversationId: conversation.id, requestId: "original", toolCallId: "a" }, { kind: "question", question: "A?" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: AgentWorkerRequest[] = [];
  let second: InteractionRecord | undefined;
  const worker = { send(request: AgentWorkerRequest): AsyncIterable<AgentWorkerEvent> {
    requests.push(request);
    const index = requests.length;
    return { async *[Symbol.asyncIterator]() {
      if (index === 1) {
        second = await coordinator.create({ conversationId: conversation.id, requestId: request.requestId, toolCallId: "b" }, { kind: "question", question: "B?" });
        yield { requestId: request.requestId, type: "tool_activity", callKey: "b", name: "request_user_input", status: "completed" } as AgentWorkerEvent;
        await gate;
        yield { requestId: request.requestId, type: "handed_off" } as AgentWorkerEvent;
      } else yield { requestId: request.requestId, type: "completed", text: "Both answers received" } as AgentWorkerEvent;
    } };
  } };
  const service = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("key"), worker, { interactions: coordinator });
  await coordinator.respond({ interactionId: first.id, expectedRevision: 1, response: { kind: "answer", text: "A" } }, { conversationId: conversation.id, source: "chat_button" });
  service.interactionChanged(conversation.id);
  await vi.waitFor(() => expect(second).toBeDefined());
  await coordinator.respond({ interactionId: second!.id, expectedRevision: 1, response: { kind: "answer", text: "B" } }, { conversationId: conversation.id, source: "chat_button" });
  service.interactionChanged(conversation.id); // Deliberately notify while the first consume is gated.
  release();
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  await vi.waitFor(() => expect(db.repos.chatInteractions.claimedEvents()).toHaveLength(0));
  expect(db.repos.chatInteractions.pendingEvents()).toHaveLength(0);
  const reloaded = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("key"), worker);
  expect(reloaded.listMessages(conversation.id).find(message => message.requestId === second!.requestId))
    .toMatchObject({ role: "assistant", content: "", toolExecutions: [{ name: "request_user_input", status: "completed" }] });
  expect(requests).toHaveLength(2);
  service.dispose(); reloaded.dispose();
});
it("keeps an unanswered automatic follow-up card anchored after history reload", async () => {
  const db = openTestDb(); dbs.push(db); const conversation = db.repos.conversations.create();
  const coordinator = new ChatInteractionCoordinator(db.repos.chatInteractions, new Map());
  const first = await coordinator.create({ conversationId: conversation.id, requestId: "original", toolCallId: "a" }, { kind: "question", question: "A?" });
  const worker = new FakeWorker({ events: request => [
    { requestId: request.requestId, type: "tool_activity", callKey: "b", name: "request_user_input", status: "completed" },
    { requestId: request.requestId, type: "handed_off" },
  ] });
  worker.onSend = request => { void coordinator.create({ conversationId: conversation.id, requestId: request.requestId, toolCallId: "b" }, { kind: "question", question: "B?" }); };
  const service = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("key"), worker, { interactions: coordinator });
  await coordinator.respond({ interactionId: first.id, expectedRevision: 1, response: { kind: "answer", text: "A" } }, { conversationId: conversation.id, source: "chat_button" });
  service.interactionChanged(conversation.id);
  await vi.waitFor(() => expect(db.repos.chatSessions.list(conversation.id)[0]?.awaitingUser).toBe(true));
  const second = coordinator.active(conversation.id)!;
  const reloaded = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("key"), worker);
  expect(second.payload).toMatchObject({ kind: "question", question: "B?" });
  expect(reloaded.listMessages(conversation.id)).toMatchObject([{ role: "assistant", requestId: second.requestId, content: "" }]);
  service.dispose(); reloaded.dispose();
});
it("does not busy retry a pending resume while model configuration is unavailable", async () => {
  const db = openTestDb(); dbs.push(db); const conversation = db.repos.conversations.create();
  const coordinator = new ChatInteractionCoordinator(db.repos.chatInteractions, new Map());
  const first = await coordinator.create({ conversationId: conversation.id, requestId: "original", toolCallId: "a" }, { kind: "question", question: "A?" });
  const profiles = makeSecrets(undefined); const worker = new FakeWorker();
  const service = new ChatService(db.repos, new ContextBuilder(db.repos), profiles, worker, { interactions: coordinator });
  await coordinator.respond({ interactionId: first.id, expectedRevision: 1, response: { kind: "answer", text: "A" } }, { conversationId: conversation.id, source: "chat_button" });
  service.interactionChanged(conversation.id);
  await vi.waitFor(() => expect(service.listMessages(conversation.id)[0]?.content).toContain("检查模型"));
  expect(profiles.getCalls).toBe(1); expect(worker.requests).toHaveLength(0);
  expect(db.repos.chatInteractions.pendingEvents()).toHaveLength(1);
  service.dispose();
});
it("answers before model/search resolution, persists user once and resumes original conversation once", async () => {
  const db = openTestDb(); dbs.push(db); const conversation = db.repos.conversations.create();
  db.repos.conversations.setWebSearchEnabled(conversation.id, true);
  const coordinator = new ChatInteractionCoordinator(db.repos.chatInteractions, new Map());
  const question = await coordinator.create({ conversationId: conversation.id, requestId: "old", toolCallId: "ask" }, { kind: "question", question: "Choose" });
  const profiles = makeSecrets("key");
  const worker = new FakeWorker({ events: request => [{ requestId: request.requestId, type: "completed", text: "continued" }] });
  const service = new ChatService(db.repos, new ContextBuilder(db.repos), profiles, worker, { interactions: coordinator, isConversationActive: () => false });
  await service.send(conversation.id, "同意", "answer", () => {}, { webSearch: true });
  expect(coordinator.get(question.id)?.status).toBe("answered");
  await vi.waitFor(() => expect(worker.requests).toHaveLength(1));
  await vi.waitFor(() => expect(db.repos.chatInteractions.claimedEvents()).toHaveLength(0));
  service.interactionChanged(conversation.id);
  expect(worker.requests[0]?.context.conversationId).toBe(conversation.id);
  expect(worker.requests[0]?.options.webSearch).toBe(true);
  expect(worker.requests[0]?.toolAccess.network).toBe("enabled");
  expect(db.repos.messages.listByConversation(conversation.id).filter(message => message.role === "user")).toHaveLength(1);
  expect(db.repos.chatInteractions.pendingEvents()).toHaveLength(0);
  service.dispose();
});
it("preserves waiting turns without failed synthetic messages and surfaces interrupted claimed resumes", async () => {
  const db = openTestDb(); dbs.push(db); const conversation = db.repos.conversations.create();
  const coordinator = new ChatInteractionCoordinator(db.repos.chatInteractions, new Map());
  const worker = new FakeWorker({ events: request => [{ requestId: request.requestId, type: "tool_activity", callKey: "ask", name: "request_user_input", status: "completed" }, { requestId: request.requestId, type: "handed_off" }] });
  const service = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("key"), worker, { interactions: coordinator });
  await service.send(conversation.id, "ask", "r", () => {});
  await vi.waitFor(() => expect(db.repos.chatSessions.list(conversation.id)[0]?.awaitingUser).toBe(true));
  expect(service.listMessages(conversation.id).some(message => message.status === "failed")).toBe(false);
  const question = await coordinator.create({ conversationId: conversation.id, requestId: "r", toolCallId: "ask" }, { kind: "question", question: "x" });
  await coordinator.respond({ interactionId: question.id, expectedRevision: 1, response: { kind: "answer", text: "x" } }, { conversationId: conversation.id, source: "chat_button" });
  const event = db.repos.chatInteractions.pendingEvents()[0]!; db.repos.chatInteractions.claimEvent(event.id);
  service.recoverInteractionResumes();
  expect(service.listMessages(conversation.id).at(-1)?.content).toContain("回复被中断");
  expect(db.repos.chatInteractions.claimedEvents()).toHaveLength(0);
  expect(worker.requests).toHaveLength(1);
  service.dispose();
});
