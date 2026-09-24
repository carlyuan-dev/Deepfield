import { afterEach, expect, it, vi } from "vitest";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import { ChatInteractionHost } from "./interaction-host.js";
import { actionFixture, testAction } from "../capabilities/action-test-helpers.js";
import type { ActionCall, CapabilityFormProvider, CapabilityFormSnapshot } from "@deepfield/capability-sdk";
import { ChatService, ContextBuilder } from "@deepfield/application";
import { FakeWorker, makeSecrets } from "../../../../../packages/application/src/chat/chat-service-helpers.js";
import type { AgentWorkerRequest, AgentWorkerEvent } from "@deepfield/contracts";
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function fixture(overrides: Parameters<typeof testAction>[0] = {}, declared = true, provider?: CapabilityFormProvider) {
  const db = openDatabase(":memory:"); migrate(db); cleanups.push(() => db.close());
  const repos = createRepositories(db); const conversation = repos.conversations.create(); const executed: string[] = [];
  const action = testAction({ mode: "immediate", taskAuthorization: { family: "add", mode: "exact_input" },
    handler: input => { executed.push((input as { value: string }).value); return { status: "completed", data: "done" }; }, ...overrides });
  if (!declared) delete action.taskAuthorization;
  const f = await actionFixture(action, provider ? (registrar, declaration) => {
    registrar.registerAction!({ definition: action, declaration });
    registrar.registerFormProvider!([{ id: "edit", actionIds: ["run"], description: "编辑" }], provider);
  } : undefined); await f.start(); cleanups.push(() => f.runtime.dispose());
  const host = new ChatInteractionHost(repos, f.registry, () => f.runtime, vi.fn()); host.begin("original", conversation.id);
  const call = (value: string): ActionCall => ({ ...f.call, input: { value } });
  const propose = (calls: ActionCall[]) => host.call("original", "offer", "proposal.create", { calls }) as Promise<{ id: string; revision: number; payload: { summary: string } }>;
  return { ...f, repos, host, conversation, executed, call, propose };
}

it("shows the full fixed bundle before approval and executes each exact input once through separate receipts", async () => {
  const f = await fixture(); const proposal = await f.propose([f.call("甲、乙"), f.call("丙、丁")]);
  expect(proposal.payload.summary).toContain("甲、乙"); expect(proposal.payload.summary).toContain("丙、丁");
  expect(f.executed).toEqual([]);
  const user = f.repos.messages.append(f.conversation.id, "user", "本次一路确认", "approval");
  const result = await f.host.respondToTask(f.conversation.id, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, user.id);
  expect(result.status).toBe("succeeded"); expect(f.executed).toEqual(["甲、乙", "丙、丁"]);
  const records = f.host.list(f.conversation.id);
  expect(records.map(item => item.status)).toEqual(["succeeded", "succeeded"]);
  expect(new Set(records.map(item => item.receiptId)).size).toBe(2);
  await expect(f.host.respondToTask(f.conversation.id, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, user.id)).rejects.toThrow();
  expect(f.executed).toHaveLength(2);
});

it("rejects an old resume proposal after the user approved its pending action", async () => {
  const f = await fixture();
  const proposal = await f.propose([f.call("first")]);
  f.host.begin("interaction-resume:old", f.conversation.id);
  await f.host.respond(f.conversation.id, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, "chat_button");
  await expect(f.host.call("interaction-resume:old", "stale", "proposal.create", { calls: [f.call("first")] })).rejects.toThrow(/Stale|过期/);
  expect(f.executed).toEqual(["first"]); expect(f.host.coordinator.active(f.conversation.id)).toBeUndefined();
});

it("executes future dynamic parameters only after visible scope confirmation and stops on new task", async () => {
  const f = await fixture({ taskAuthorization: { mode: "scope", dynamicFields: ["value"], resourceFields: [], outputBindings: [] } });
  const proposal = await f.host.call("original", "scope", "proposal.create", { endCondition: "加入找到的记录", firstCall: f.call("first"), rules: [
    { id: "add", call: { ...f.call(""), input: {} }, dynamicFields: ["value"], maxExecutions: 3 },
  ] }) as { id: string; revision: number; payload: { summary: string } };
  expect(proposal.payload.summary).toContain("最多 3 次"); expect(f.executed).toEqual([]);
  const human = f.repos.messages.append(f.conversation.id, "user", "确认无误", "human");
  await f.host.respond(f.conversation.id, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, "user_message", human.id);
  expect(f.executed).toEqual(["first"]);
  f.host.begin("continuation", f.conversation.id);
  const next = await f.host.requestApproval({ conversationId: f.conversation.id, requestId: "continuation", toolCallId: "next" }, f.call("discovered"));
  expect(next.status).toBe("succeeded"); expect(f.executed).toEqual(["first", "discovered"]);
  f.host.revokeTask(f.conversation.id); f.host.begin("new-task", f.conversation.id);
  const unapproved = await f.host.requestApproval({ conversationId: f.conversation.id, requestId: "new-task", toolCallId: "next" }, f.call("outside"));
  expect(unapproved.status).toBe("waiting"); expect(f.executed).toEqual(["first", "discovered"]);
});

async function grantedScope() {
  const f = await fixture({ taskAuthorization: { mode: "scope", dynamicFields: ["value"], resourceFields: [], outputBindings: [] } });
  f.repos.capabilityInvocations = f.invocations;
  const item = await f.host.call("original", "scope", "proposal.create", { firstCall: f.call("first"), endCondition: "完成当前任务", rules: [
    { id: "add", call: { ...f.call(""), input: {} }, dynamicFields: ["value"], maxExecutions: 3 },
  ] }) as { id: string; revision: number };
  await f.host.respond(f.conversation.id, { interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision", decision: "approve" } }, "chat_button");
  return f;
}

it("cancels a pending question and revokes its task grant on an explicit cancel message", async () => {
  const f = await grantedScope();
  const question = await f.host.coordinator.create({ conversationId: f.conversation.id, requestId: "question", toolCallId: "ask" }, { kind: "question", question: "选择范围" });
  const service = new ChatService(f.repos, new ContextBuilder(f.repos), makeSecrets(undefined), new FakeWorker(), {
    interactions: f.host.coordinator, onUserMessage: id => f.host.revokeTask(id),
    respondToInteraction: (id, command, messageId) => f.host.respond(id, command, "user_message", messageId),
  }); cleanups.push(() => service.dispose());
  await service.send(f.conversation.id, "取消", "cancel", () => {});
  expect(f.host.coordinator.get(question.id)?.status).toBe("cancelled");
  expect(f.host.taskScope(f.conversation.id)).toBeUndefined();
  f.host.begin("after-cancel", f.conversation.id);
  const remaining = await f.host.requestApproval({ conversationId: f.conversation.id, requestId: "after-cancel", toolCallId: "remaining" }, f.call("not-authorized"));
  expect(remaining.status).toBe("waiting"); expect(f.executed).toEqual(["first"]);
});

it("consumes same-turn successful scoped receipts with the final answer without a second resume", async () => {
  const f = await grantedScope(); const requests: AgentWorkerRequest[] = [];
  const worker = { send(request: AgentWorkerRequest): AsyncIterable<AgentWorkerEvent> {
    requests.push(request); const index = requests.length;
    return { async *[Symbol.asyncIterator]() {
      if (index === 1) {
        const result = await f.host.requestApproval({ conversationId: f.conversation.id, requestId: request.requestId, toolCallId: "same-turn" }, f.call("discovered"));
        yield { requestId: request.requestId, type: "transcript_checkpoint", messages: [{ role: "toolResult", toolCallId: "same-turn", toolName: "capability_invoke", isError: false, timestamp: 1,
          content: [{ type: "text", text: JSON.stringify(f.host.resultFor(result)) }] }] };
      }
      yield { requestId: request.requestId, type: "completed", text: index === 1 ? "当前任务已完成" : "多余的第二次回答" };
    } };
  } };
  const service = new ChatService(f.repos, new ContextBuilder(f.repos), makeSecrets("key"), worker, {
    interactions: f.host.coordinator, onRequestStarted: (id, conversationId) => f.host.begin(id, conversationId),
    onRequestFinished: id => f.host.end(id), onTaskStopped: id => f.host.revokeTask(id),
  }); cleanups.push(() => service.dispose());
  service.interactionChanged(f.conversation.id);
  await vi.waitFor(() => expect(f.repos.chatInteractions.pendingEvents()).toHaveLength(0));
  await vi.waitFor(() => expect(f.repos.chatInteractions.claimedEvents()).toHaveLength(0));
  expect(requests).toHaveLength(1);
  expect(f.repos.messages.listByConversation(f.conversation.id).filter(item => item.role === "assistant")).toHaveLength(1);
  expect(f.executed).toEqual(["first", "discovered"]);
  expect(f.host.list(f.conversation.id).filter(item => item.status === "succeeded")).toHaveLength(2);
});

function editableProvider(unknownContinuation = false): CapabilityFormProvider {
  let value = "first"; let revision = 1;
  const snapshot = (): CapabilityFormSnapshot => ({ draft: { capabilityId: "public-package", draftId: "draft", revision: String(revision) },
    view: { capabilityId: "public-package", viewId: "form", input: {} }, values: { value }, inputSchema: {}, transitions: [], readyToSubmit: true, summary: value });
  return {
    prepare: async (_form, _action, input) => { value = (input as { value: string }).value; return snapshot(); },
    read: async () => snapshot(), update: async (_ref, patch) => { value = (patch as { value: string }).value; revision++; return snapshot(); },
    transition: async () => snapshot(), validate: async () => ({ valid: true, fieldErrors: [] }),
    submission: async () => ({ actionId: "run", input: { value }, revision: String(revision) }), release: async () => {},
    ...(unknownContinuation ? { afterAction: async () => { value = "unknown candidate"; revision++; return { snapshot: snapshot(), nextActionId: "run" }; } } : {}),
  };
}

it("does not inherit authorization into unknown package-generated candidate input", async () => {
  const f = await fixture({}, true, editableProvider(true));
  const proposal = await f.propose([f.call("first"), f.call("second")]);
  await f.host.respond(f.conversation.id, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, "chat_button");
  expect(f.executed).toEqual(["first"]);
  expect(f.host.coordinator.active(f.conversation.id)?.payload).toMatchObject({ kind: "approval", summary: expect.stringContaining("unknown candidate") });
});

it("requires the new displayed revision after an edit, then approves the visibly revised exact bundle", async () => {
  const f = await fixture({}, true, editableProvider());
  const proposal = await f.propose([f.call("first"), f.call("second")]);
  const edited = await f.host.updateEditor(f.conversation.id, proposal.id, proposal.revision, { value: "revised first" });
  await expect(f.host.respond(f.conversation.id, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, "chat_button")).rejects.toThrow();
  expect(f.executed).toEqual([]); expect(edited.interaction.payload).toMatchObject({ summary: expect.stringContaining("revised first") });
  await f.host.respond(f.conversation.id, { interactionId: proposal.id, expectedRevision: edited.interaction.revision, response: { kind: "decision", decision: "approve" } }, "chat_button");
  expect(f.executed).toEqual(["revised first", "second"]);
});

it("retains an inert whole bundle across host restart but requires fresh user confirmation", async () => {
  const f = await fixture(); const proposal = await f.propose([f.call("one"), f.call("two")]);
  const restarted = new ChatInteractionHost(f.repos, f.registry, () => f.runtime, vi.fn());
  await restarted.recover(); expect(f.executed).toEqual([]);
  const item = restarted.coordinator.get(proposal.id)!;
  await restarted.respond(f.conversation.id, { interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision", decision: "approve" } }, "chat_button");
  expect(f.executed).toEqual(["one", "two"]);
});

it("does not remember an unbound delegation message for a later model proposal", async () => {
  const f = await fixture();
  const service = new ChatService(f.repos, new ContextBuilder(f.repos), makeSecrets("key"), new FakeWorker(), {
    interactions: f.host.coordinator, onUserMessage: id => f.host.revokeTask(id),
    respondToTask: (id, command, messageId) => f.host.respondToTask(id, command, messageId),
  }); cleanups.push(() => service.dispose());
  await service.send(f.conversation.id, "本次一路确认", "unbound", () => {});
  f.host.begin("original", f.conversation.id);
  const proposal = await f.propose([f.call("later")]);
  expect(f.host.coordinator.get(proposal.id)?.status).toBe("waiting"); expect(f.executed).toEqual([]);
});

it("does not grant from fake user provenance or execute unlisted follow-ups", async () => {
  const f = await fixture(); const proposal = await f.propose([f.call("甲")]);
  await expect(f.host.respondToTask(f.conversation.id, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, "invented")).rejects.toThrow();
  const assistant = f.repos.messages.append(f.conversation.id, "assistant", "本次一路确认", "model");
  await expect(f.host.respondToTask(f.conversation.id, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, assistant.id)).rejects.toThrow();
  expect(f.executed).toEqual([]);
});

it("revocation during the first action prevents the rest of the bundle", async () => {
  let host: ChatInteractionHost; let conversationId: string;
  const executed: string[] = [];
  const f = await fixture({ handler: input => { executed.push((input as { value: string }).value); host.revokeTask(conversationId); return { status: "completed", data: "done" }; } });
  host = f.host; conversationId = f.conversation.id;
  const proposal = await f.propose([f.call("first"), f.call("second")]);
  const user = f.repos.messages.append(conversationId as never, "user", "本次一路确认", "approve");
  await host.respondToTask(conversationId, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, user.id);
  expect(executed).toEqual(["first"]);
});

it("rejects bundles for old packages, destructive actions, and background jobs", async () => {
  const old = await fixture({}, false);
  await expect(old.propose([old.call("one")])).rejects.toThrow(); expect(old.executed).toEqual([]);
  for (const overrides of [{ effects: { data: "destructive" as const, consumesResources: false } }, { mode: "task" as const }]) {
    const f = await fixture(overrides);
    await expect(f.propose([f.call("one")])).rejects.toThrow(); expect(f.executed).toEqual([]);
  }
});

it("routes the reported real-user sentence to its concrete proposal and never treats a question answer as a grant", async () => {
  const f = await fixture(); const proposal = await f.propose([f.call("甲、乙、丙、丁")]);
  const service = new ChatService(f.repos, new ContextBuilder(f.repos), makeSecrets(undefined), new FakeWorker(), {
    interactions: f.host.coordinator,
    respondToInteraction: (id, command, messageId) => f.host.respond(id, command, "user_message", messageId),
    respondToTask: (id, command, messageId) => f.host.respondToTask(id, command, messageId),
    onUserMessage: id => f.host.revokeTask(id),
  }); cleanups.push(() => service.dispose());
  await service.send(f.conversation.id, "可以，补进去，你一路确认就行，不要我来点", "real-user", () => {});
  expect(f.host.coordinator.get(proposal.id)?.status).toBe("succeeded"); expect(f.executed).toEqual(["甲、乙、丙、丁"]);
  const question = await f.host.coordinator.create({ conversationId: f.conversation.id, requestId: "question", toolCallId: "ask" }, { kind: "question", question: "范围？" });
  await service.send(f.conversation.id, "本次一路确认", "answer", () => {});
  expect(f.host.coordinator.get(question.id)?.status).toBe("answered"); expect(f.executed).toHaveLength(1);
});

it("keeps full-bundle confirmation consistent for both buttons and ordinary text, retaining one resume event", async () => {
  for (const source of ["chat_button", "form_button", "user_message"] as const) {
    const f = await fixture(); const proposal = await f.propose([f.call("one"), f.call("two")]);
    const message = source === "user_message" ? f.repos.messages.append(f.conversation.id, "user", "确认无误", "user") : undefined;
    await f.host.respond(f.conversation.id, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, source, message?.id);
    expect(f.executed).toEqual(["one", "two"]);
    expect(f.repos.chatInteractions.pendingEvents(f.conversation.id)).toHaveLength(1);
  }
});

it("revokes even inside the final gateway preview before any action is dispatched", async () => {
  let f: Awaited<ReturnType<typeof fixture>>; let count = 0;
  f = await fixture({ presentOperation: async () => { if (++count === 2) f.host.revokeTask(f.conversation.id); return undefined; } });
  const proposal = await f.propose([f.call("one")]);
  const user = f.repos.messages.append(f.conversation.id, "user", "本次一路确认", "approval");
  const result = await f.host.respondToTask(f.conversation.id, { interactionId: proposal.id, expectedRevision: proposal.revision, response: { kind: "decision", decision: "approve" } }, user.id);
  expect(f.executed).toEqual([]); expect(result.status).toBe("failed");
});
