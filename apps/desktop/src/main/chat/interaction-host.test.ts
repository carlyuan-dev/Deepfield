import { afterEach, expect, it, vi } from "vitest";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import type { CapabilityFormProvider, CapabilityFormSnapshot } from "@deepfield/capability-sdk";
import { CapabilityRegistry } from "../capabilities/registry.js";
import { actionFixture, testAction } from "../capabilities/action-test-helpers.js";
import { ActionGateway } from "../capabilities/action-gateway.js";
import { ChatInteractionHost } from "./interaction-host.js";
import { CapabilityChatHost } from "../capabilities/chat-host.js";
import { ViewNavigation } from "../capabilities/view-navigation.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function database() { const db = openDatabase(":memory:"); migrate(db); cleanups.push(() => db.close()); return createRepositories(db); }

it("opens a no-form destructive approval's package context without executing it", async () => {
  const repos = database(); const conversation = repos.conversations.create();
  const target = { capabilityId: "public-package", viewId: "home", input: {} };
  const handler = vi.fn(async () => ({ status: "completed" as const, data: "done" }));
  const action = testAction({ mode: "immediate", handler, presentOperation: () => ({ text: "Delete", target, autoOpen: true }) });
  const f = await actionFixture(action); await f.start(); cleanups.push(() => f.runtime.dispose());
  const opened = vi.fn(async () => ({ status: "opened" }));
  const host = new ChatInteractionHost(repos, f.registry, () => f.runtime, vi.fn(), undefined, opened);
  host.begin("r", conversation.id);
  const item = await host.requestApproval({ conversationId: conversation.id, requestId: "r", toolCallId: "t" }, f.call);
  expect(await host.autoOpenEditor(conversation.id, item.id)).toEqual({ status: "opened" });
  expect(opened).toHaveBeenCalledWith(conversation.id, target, f.runtime.navigation.manualGeneration());
  expect(handler).not.toHaveBeenCalled();
});

it("publishes results only after the interaction becomes terminal, preserving its request navigation generation", async () => {
  const f = await editableFixture();
  const states: string[] = []; const generations: number[] = [];
  const generation = f.fixture.runtime.navigation.manualGeneration();
  const host = new ChatInteractionHost(f.repos, f.fixture.registry, () => f.fixture.runtime, vi.fn(), (owner, _id, _result, originalGeneration) => {
    states.push(host.list(owner.conversationId).find(item => item.requestId === "result-request")!.status);
    generations.push(originalGeneration!);
  });
  host.begin("result-request", f.conversation.id);
  await f.host.respond(f.conversation.id, { interactionId: f.item.id, expectedRevision: f.item.revision, response: { kind: "decision", decision: "cancel" } }, "chat_button");
  const item = await host.requestApproval({ conversationId: f.conversation.id, requestId: "result-request", toolCallId: "t2" }, f.fixture.call);
  f.fixture.runtime.navigation.noteManualNavigation();
  await host.respond(f.conversation.id, { interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision", decision: "approve" } }, "chat_button");
  expect(states).toEqual(["succeeded"]);
  expect(generations).toEqual([generation]);
});

async function editableFixture() {
  const repos = database(); const conversation = repos.conversations.create();
  let version = 1; let value = "before";
  const snapshot = (): CapabilityFormSnapshot => ({ draft: { capabilityId: "public-package", draftId: "draft", revision: String(version) },
    view: { capabilityId: "public-package", viewId: "editor", input: { version } }, values: { value }, inputSchema: {}, transitions: [{ id: "next", label: "Next" }], readyToSubmit: true, summary: value });
  const provider: CapabilityFormProvider = { prepare: async () => snapshot(), read: async () => snapshot(),
    update: async (_ref, patch) => { const next = (patch as { value: string }).value; if (!next) throw new Error("Invalid value"); value = next; version++; return snapshot(); },
    transition: async () => { throw new Error("Invalid transition"); }, validate: async () => ({ valid: true, fieldErrors: [] }),
    submission: async () => ({ actionId: "run", input: { value }, revision: String(version) }), release: async () => {} };
  const action = testAction({ mode: "immediate" });
  const fixture = await actionFixture(action, (registrar, declaration) => { registrar.registerAction!({ definition: action, declaration }); registrar.registerFormProvider!([{ id: "form", actionIds: ["run"], description: "Edit" }], provider); });
  await fixture.start(); cleanups.push(() => fixture.runtime.dispose());
  const host = new ChatInteractionHost(repos, fixture.registry, () => fixture.runtime, vi.fn()); host.begin("r", conversation.id);
  const item = await host.requestApproval({ conversationId: conversation.id, requestId: "r", toolCallId: "t" }, fixture.call);
  return { repos, conversation, fixture, provider, host, item, snapshot, mutate: () => { value = "uncertain change"; version++; } };
}

it("recovers only unchanged model-owned rejected edits and transitions, allowing correction", async () => {
  const f = await editableFixture();
  await expect(f.host.call("r", "edit", "draft.update", { expectedRevision: 1, patch: { value: "" } })).rejects.toThrow("Invalid value");
  expect(f.host.coordinator.get(f.item.id)).toMatchObject({ status: "waiting", revision: 3 });
  await expect(f.host.call("r", "step", "draft.transition", { expectedRevision: 3, transitionId: "next" })).rejects.toThrow("Invalid transition");
  expect(f.host.coordinator.get(f.item.id)).toMatchObject({ status: "waiting", revision: 5 });
  await f.host.call("r", "correct", "draft.update", { expectedRevision: 5, patch: { value: "corrected" } });
  expect(f.host.coordinator.get(f.item.id)).toMatchObject({ status: "waiting", revision: 7 });
  expect(f.snapshot().values).toEqual({ value: "corrected" });
  const human = f.host.beginEdit(f.conversation.id, f.item.id, 7);
  await expect(f.host.call("r", "model", "draft.update", { expectedRevision: human.revision, patch: { value: "x" } })).rejects.toThrow("Stale request");
  await expect(f.host.updateEditor(f.conversation.id, f.item.id, human.revision, { value: "" })).rejects.toThrow("Invalid value");
  expect(f.host.coordinator.get(f.item.id)).toMatchObject({ status: "editing", revision: human.revision });
});

it("keeps a model edit locked when the provider mutates then throws", async () => {
  const f = await editableFixture();
  // The registered read method closes over package-owned state, independent of mutable provider methods.
  const provider = f.fixture.registry.formProvider("public-package")!;
  const originalRead = provider.read;
  let reads = 0;
  vi.spyOn(f.fixture.registry, "formProvider").mockReturnValue({ ...provider, read: async ref => {
    reads++; return originalRead(ref);
  }, update: async () => { f.mutate(); throw new Error("Unknown mutation"); } });
  await expect(f.host.call("r", "edit", "draft.update", { expectedRevision: 1, patch: {} })).rejects.toThrow("Unknown mutation");
  expect(f.host.coordinator.get(f.item.id)).toMatchObject({ status: "editing", revision: 2 });
  expect(reads).toBeGreaterThanOrEqual(2);
});

it("manually resolves owned current views after edits and host restart through real navigation authorization", async () => {
  const f = await editableFixture(); const other = f.repos.conversations.create();
  const opened: unknown[] = [];
  const navigation = new ViewNavigation(async target => ({ status: "resolved", view: target as CapabilityFormSnapshot["view"] }));
  navigation.attach(1, event => { if (event.kind === "open") { opened.push(event.target); navigation.ack(1, event.requestId, "public-package", { status: "opened" }); } });
  cleanups.push(() => navigation.dispose());
  const runtime = { ...f.fixture.runtime, navigation };
  const capabilities = new CapabilityChatHost(() => runtime, f.fixture.registry, f.repos);
  cleanups.push(() => capabilities.dispose()); capabilities.setActiveConversation(f.conversation.id);
  const restore = () => new ChatInteractionHost(f.repos, f.fixture.registry, () => runtime, vi.fn(), undefined, undefined,
    (owner, target) => capabilities.openForConversation(owner, target));
  const host = restore();
  expect(await capabilities.openForConversation(f.conversation.id, f.snapshot().draft)).toEqual({ status: "not_found" });
  expect(await host.openEditorManually(f.conversation.id, f.item.id)).toMatchObject({ status: "opened" });
  await f.host.call("r", "edit", "draft.update", { expectedRevision: 1, patch: { value: "updated" } });
  expect(await host.openEditorManually(f.conversation.id, f.item.id)).toMatchObject({ status: "opened" });
  const restarted = restore(); await restarted.recover();
  expect(await restarted.openEditorManually(f.conversation.id, f.item.id)).toMatchObject({ status: "opened" });
  expect(opened).toEqual([
    { capabilityId: "public-package", viewId: "editor", input: { version: 1 } },
    { capabilityId: "public-package", viewId: "editor", input: { version: 2 } },
    { capabilityId: "public-package", viewId: "editor", input: { version: 2 } },
  ]);
  await expect(restarted.openEditorManually(other.id, f.item.id)).rejects.toThrow("binding mismatch");
  capabilities.setActiveConversation(other.id);
  expect(await restarted.openEditorManually(f.conversation.id, f.item.id)).toMatchObject({ status: "blocked" });
  const registered = f.fixture.registry.formProvider("public-package")!;
  vi.spyOn(f.fixture.registry, "formProvider").mockReturnValue({ ...registered, read: async () => ({ ...f.snapshot(), view: { capabilityId: "foreign", viewId: "editor", input: {} } }) });
  await expect(restarted.openEditorManually(f.conversation.id, f.item.id)).rejects.toThrow("capability mismatch");
});

it("binds a zero-capability question to the active request and rejects model authority", async () => {
  const repos = database(); const conversation = repos.conversations.create();
  const host = new ChatInteractionHost(repos, new CapabilityRegistry(), () => undefined, vi.fn());
  await expect(host.call("forged", "t", "question", { question: "x" })).rejects.toThrow("Inactive");
  host.begin("r", conversation.id);
  await expect(host.call("r", "t", "question", { question: "x", source: "user_message" })).rejects.toThrow("Invalid");
  const item = await host.call("r", "t", "question", { question: "Choose", options: [{ id: "approve", label: "同意" }] }) as { id: string; revision: number };
  await host.respond(conversation.id, { interactionId: item.id, expectedRevision: item.revision, response: { kind: "answer", text: "同意" } }, "chat_button");
  expect(host.list(conversation.id)[0]?.status).toBe("answered");
});

it("supports generic fake file writes without a Capability branch", async () => {
  const repos = database(); const conversation = repos.conversations.create();
  const host = new ChatInteractionHost(repos, new CapabilityRegistry(), () => undefined, vi.fn());
  const execute = vi.fn(async () => ({ status: "succeeded" as const, summary: "Saved" }));
  host.registerAdapter("fake-file", { read: async () => ({ version: "v1", summary: "Save file" }), execute, reconcile: async () => "unknown" });
  const item = await host.coordinator.create({ conversationId: conversation.id, requestId: "r", toolCallId: "t" }, { kind: "approval", summary: "", operation: { provider: "fake-file", operationId: "file", contractVersion: "1" } });
  await host.respond(conversation.id, { interactionId: item.id, expectedRevision: 1, response: { kind: "decision", decision: "approve" } }, "chat_button");
  expect(execute).toHaveBeenCalledOnce(); expect(execute.mock.calls[0]).toHaveLength(4);
});

it("uses fresh frozen edited input, protects dirty locks and original owner after switching", async () => {
  const repos = database(); const conversation = repos.conversations.create(); const other = repos.conversations.create();
  let version = 1; let value = "before";
  const snapshot = (): CapabilityFormSnapshot => ({ draft: { capabilityId: "public-package", draftId: "draft", revision: String(version) }, view: { capabilityId: "public-package", viewId: "editor", input: {} }, values: { value }, inputSchema: {}, transitions: [], readyToSubmit: true, summary: value });
  const provider: CapabilityFormProvider = { prepare: async () => snapshot(), read: async () => snapshot(),
    update: async (_ref, patch) => { value = (patch as { value: string }).value; version++; return snapshot(); }, transition: async () => snapshot(),
    validate: async () => ({ valid: true, fieldErrors: [] }), submission: async () => ({ actionId: "run", input: { value }, revision: String(version) }), release: vi.fn(async () => {}) };
  const received: unknown[] = [];
  const action = testAction({ mode: "immediate", handler: input => { received.push(input); return { status: "completed", data: "done" }; } });
  const fixture = await actionFixture(action, (registrar, declaration) => { registrar.registerAction!({ definition: action, declaration }); registrar.registerFormProvider!([{ id: "form", actionIds: ["run"], description: "Edit" }], provider); });
  await fixture.start(); cleanups.push(() => fixture.runtime.dispose());
  const runtime = { ...fixture.runtime, actionGateway: new ActionGateway(fixture.registry, () => fixture.runtime.actionCatalog, fixture.runtime.actionConfirmations, repos.capabilityInvocations) };
  const host = new ChatInteractionHost(repos, fixture.registry, () => runtime, vi.fn());
  const capability = new CapabilityChatHost(() => runtime, fixture.registry, repos, host); cleanups.push(() => capability.dispose());
  capability.begin("r", conversation.id, "Create"); host.begin("r", conversation.id);
  capability.setActiveConversation(conversation.id);
  await capability.call("r", "describe", "describe", fixture.call);
  const result = await capability.call("r", "tool", "invoke", fixture.call) as { status: string; interactionId: string };
  expect(result.status).toBe("awaiting_user"); expect(capability.pendingConfirmations(conversation.id)).toEqual([]);
  const locked = host.beginEdit(conversation.id, result.interactionId, 1);
  expect(() => host.beginEdit(conversation.id, result.interactionId, 1)).toThrow("Stale");
  await expect(host.updateEditor(conversation.id, result.interactionId, 1, { value: "stale" })).rejects.toThrow("Stale");
  await expect(host.respond(conversation.id, { interactionId: result.interactionId, expectedRevision: 1, response: { kind: "decision", decision: "approve" } }, "form_button")).rejects.toThrow("Stale");
  await expect(host.call("r", "model-edit", "draft.update", { expectedRevision: locked.revision, patch: { value: "overwrite" } })).rejects.toThrow("Stale request");
  const updated = await host.updateEditor(conversation.id, result.interactionId, locked.revision, { value: "after" });
  expect(updated.interaction.revision).toBe(3);
  capability.setActiveConversation(other.id); capability.end("r"); host.end("r");
  const command = { interactionId: result.interactionId, expectedRevision: 3, response: { kind: "decision" as const, decision: "approve" as const } };
  await expect(host.respond(other.id, command, "form_button")).rejects.toThrow("another conversation");
  await Promise.all([host.respond(conversation.id, command, "form_button"), host.respond(conversation.id, command, "chat_button")]);
  expect(received).toEqual([{ value: "after" }]); expect(host.list(conversation.id)[0]?.status).toBe("succeeded");
});

it("keeps legacy package approval read-only and accepted task distinct from finished", async () => {
  const repos = database(); const conversation = repos.conversations.create();
  const fixture = await actionFixture(testAction({ handler: () => ({ status: "accepted", taskRef: { capabilityId: "public-package", taskId: "task" }, taskStatus: "queued" }) }));
  await fixture.start(); cleanups.push(() => fixture.runtime.dispose());
  const runtime = { ...fixture.runtime, actionGateway: new ActionGateway(fixture.registry, () => fixture.runtime.actionCatalog, fixture.runtime.actionConfirmations, repos.capabilityInvocations) };
  const host = new ChatInteractionHost(repos, fixture.registry, () => runtime, vi.fn()); host.begin("r", conversation.id);
  const item = await host.requestApproval({ conversationId: conversation.id, requestId: "r", toolCallId: "t" }, fixture.call);
  await expect(host.readEditor(conversation.id, item.id)).rejects.toThrow("no editable");
  const result = await host.respond(conversation.id, { interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision", decision: "approve" } }, "chat_button");
  expect(result.status).toBe("submitted"); expect(result.taskId).toBe("task");
});
