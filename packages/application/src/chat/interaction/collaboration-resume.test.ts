import { afterEach, expect, it, vi } from "vitest";
import type { ChatCollaborationState } from "@deepfield/contracts";
import { openTestDb, type TestDb } from "../../testing/application-test-helpers.js";
import { ChatInteractionCoordinator } from "./coordinator.js";
import { ChatService } from "../chat-service.js";
import { ContextBuilder } from "../context-builder.js";
import { FakeWorker, makeSecrets } from "../chat-service-helpers.js";

const dbs: TestDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.cleanup(); });

async function fixture(status: ChatCollaborationState["status"], acknowledged = true) {
  const db = openTestDb(); dbs.push(db);
  const conversation = db.repos.conversations.create();
  const coordinator = new ChatInteractionCoordinator(db.repos.chatInteractions, new Map());
  const state: ChatCollaborationState = { version: 1, scopeId: "collab:original", rootRequestId: "original", revision: 10,
    status, snapshot: "{}", modelCalls: 29, remainingMs: 90000, searchConsumed: 3, fetchConsumed: 2,
    resultCursor: 7, tasks: [{ taskId: "task", runId: "run", title: "核查数据", instruction: "核查数据",
      status: "completed", sequence: 1, result: "已核实的结果" }] };
  db.repos.chatSessions.checkpoint(conversation.id, "original", "disabled", []);
  db.repos.chatSessions.collaboration(conversation.id, "original", "disabled", state);
  if (acknowledged) db.repos.chatSessions.awaitUser(conversation.id, "original");
  const item = await coordinator.create({ conversationId: conversation.id, requestId: "original", toolCallId: "ask" },
    { kind: "question", question: "下一步选哪项？" });
  const worker = new FakeWorker({ events: request => [{ type: "completed", requestId: request.requestId, text: "已继续" }] });
  const profiles = makeSecrets("key");
  const service = new ChatService(db.repos, new ContextBuilder(db.repos), profiles, worker, { interactions: coordinator });
  const respond = async (cancel = false) => {
    await coordinator.respond({ interactionId: item.id, expectedRevision: 1,
      response: cancel ? { kind: "decision", decision: "cancel" } : { kind: "answer", text: "继续分析" } },
    { conversationId: conversation.id, source: "chat_button" });
    service.interactionChanged(conversation.id);
    await vi.waitFor(() => expect(db.repos.chatInteractions.pendingEvents()).toHaveLength(0));
    await vi.waitFor(() => expect(db.repos.chatInteractions.claimedEvents()).toHaveLength(0));
  };
  return { db, conversation, state, worker, profiles, service, respond };
}

it("continues a confirmed handoff with the same consumed resources and child results", async () => {
  const f = await fixture("waiting_user");
  try {
    await f.respond();
    expect(f.worker.requests).toHaveLength(1);
    expect(f.worker.requests[0]?.context.collaboration).toEqual(f.state);
  } finally { f.service.dispose(); }
});

it.each([
  ["interrupted", true], ["running", false], ["waiting_user", false],
] as const)("does not create a fresh budget for unconfirmed handoff %s / acknowledged=%s", async (status, acknowledged) => {
  const f = await fixture(status, acknowledged);
  try {
    await f.respond();
    expect(f.worker.requests).toHaveLength(0);
    expect(f.profiles.getCalls).toBe(0);
    expect(f.service.listMessages(f.conversation.id).at(-1)?.content).toContain("无法自动继续");
    expect(f.db.repos.chatSessions.list(f.conversation.id)[0]?.collaboration).toMatchObject({
      status: "interrupted", modelCalls: 29, remainingMs: 90000, tasks: [{ result: "已核实的结果" }],
    });
    f.service.recoverInteractionResumes();
    expect(f.worker.requests).toHaveLength(0);
  } finally { f.service.dispose(); }
});

it("cancelling a question closes the scope without starting another agent turn", async () => {
  const f = await fixture("waiting_user");
  try {
    await f.respond(true);
    expect(f.worker.requests).toHaveLength(0);
    expect(f.profiles.getCalls).toBe(0);
    expect(f.db.repos.chatSessions.list(f.conversation.id)[0]?.collaboration?.status).toBe("cancelled");
    expect(f.service.listMessages(f.conversation.id).at(-1)?.content).toContain("已取消本轮协作");
  } finally { f.service.dispose(); }
});

it("a late answer cannot reopen a scope completed by a later continuation", async () => {
  const f = await fixture("waiting_user");
  try {
    f.db.repos.chatSessions.collaboration(f.conversation.id, "later", "disabled", {
      ...f.state, revision: 11, status: "completed", modelCalls: 32,
    });
    await f.respond();
    expect(f.worker.requests).toHaveLength(0);
    expect(f.db.repos.chatSessions.list(f.conversation.id).at(-1)?.collaboration).toMatchObject({ modelCalls: 32, status: "completed" });
  } finally { f.service.dispose(); }
});
