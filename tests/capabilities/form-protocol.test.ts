import { afterEach, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import type { CapabilityFormProvider, CapabilityFormSnapshot } from "@deepfield/capability-sdk";
import { actionFixture, testAction } from "../../apps/desktop/src/main/capabilities/action-test-helpers.js";
import { ActionGateway } from "../../apps/desktop/src/main/capabilities/action-gateway.js";
import { ChatInteractionHost } from "../../apps/desktop/src/main/chat/interaction-host.js";
import { createBoundInteractionEditor } from "../../apps/desktop/src/renderer/capabilities/bound-interaction-editor.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it("discovers a notes form and executes the jointly edited draft through the generic bridge", async () => {
  const savedNote = vi.fn();
  const action = testAction({
    title: "Save note",
    inputSchema: Type.Object({ title: Type.String(), body: Type.String() }, { additionalProperties: false }),
    handler: input => { savedNote(structuredClone(input)); return { status: "completed", data: "saved" }; },
  });
  let values = { title: "Initial", body: "Initial body" };
  let version = 1;
  const snapshot = (): CapabilityFormSnapshot => ({
    draft: { capabilityId: "public-package", draftId: "note-1", revision: String(version) },
    view: { capabilityId: "public-package", viewId: "note-edit", input: { draftId: "note-1" } },
    values: structuredClone(values), inputSchema: action.inputSchema, transitions: [], readyToSubmit: true,
    summary: `Save note: ${values.title}`,
  });
  const provider: CapabilityFormProvider = {
    prepare: async (_formId, _actionId, input) => { values = structuredClone(input) as typeof values; return snapshot(); },
    read: async () => snapshot(),
    update: async (_ref, patch) => { values = { ...values, ...patch as Partial<typeof values> }; version++; return snapshot(); },
    transition: async () => snapshot(), validate: async () => ({ valid: true, fieldErrors: [] }),
    submission: async () => ({ actionId: "run", input: structuredClone(values), revision: String(version) }),
    release: async () => {},
  };
  const fixture = await actionFixture(action, (registrar, declaration) => {
    registrar.registerAction!({ definition: action, declaration });
    registrar.registerFormProvider!([
      { id: "note-edit", actionIds: ["run"], description: "Edit note" },
      { id: "broken-optional", actionIds: ["missing-action"], description: "Invalid binding" },
    ], provider);
  });
  await fixture.start(); cleanups.push(() => fixture.runtime.dispose());
  expect(fixture.registry.forms("public-package").map(form => form.id)).toEqual(["note-edit"]);
  expect(fixture.runtime.actionCatalog.find("public-package", "run")).toBeDefined();

  const db = openDatabase(":memory:"); migrate(db); cleanups.push(() => db.close());
  const repos = createRepositories(db); const conversation = repos.conversations.create();
  const runtime = { ...fixture.runtime, actionGateway: new ActionGateway(fixture.registry, () => fixture.runtime.actionCatalog,
    fixture.runtime.actionConfirmations, repos.capabilityInvocations) };
  const host = new ChatInteractionHost(repos, fixture.registry, () => runtime, vi.fn());
  host.begin("notes-request", conversation.id);
  const pending = await host.requestApproval({ conversationId: conversation.id, requestId: "notes-request", toolCallId: "save-note" },
    { ...fixture.call, input: { title: "Initial", body: "Initial body" } });
  const chat = {
    readInteractionEditor: (owner: string, id: string) => host.readEditor(owner, id),
    beginInteractionEdit: (owner: string, id: string, revision: number) => Promise.resolve(host.beginEdit(owner, id, revision)),
    updateInteractionEditor: (owner: string, id: string, revision: number, patch: unknown) => host.updateEditor(owner, id, revision, patch),
    transitionInteractionEditor: (owner: string, id: string, revision: number, transition: string) => host.updateEditor(owner, id, revision, undefined, transition),
    respondInteractionEditor: (owner: string, command: Parameters<typeof host.respond>[1]) => host.respond(owner, command, "form_button"),
    onInteractions: host.onChanged.bind(host),
  } as Parameters<typeof createBoundInteractionEditor>[0];
  const editor = createBoundInteractionEditor(chat, { conversationId: conversation.id, interactionId: pending.id }, vi.fn());
  expect((await editor.read()).snapshot.view.viewId).toBe("note-edit");
  await host.call("notes-request", "model-edit", "draft.update", { expectedRevision: pending.revision, patch: { body: "Model body" } });
  const shared = await editor.read();
  await editor.beginEdit(shared.revision);
  await expect(host.respond(conversation.id, { interactionId: pending.id, expectedRevision: shared.revision,
    response: { kind: "decision", decision: "approve" } }, "chat_button")).rejects.toThrow("Stale");
  const edited = await editor.update(shared.revision + 1, { title: "User title" });
  await editor.respond(edited.revision, "approve");
  expect(savedNote).toHaveBeenCalledOnce();
  expect(savedNote).toHaveBeenCalledWith({ title: "User title", body: "Model body" });
  expect(host.list(conversation.id)[0]?.status).toBe("succeeded");

  await fixture.runtime.setEnabled("public-package", false);
  const preparedAfterRestart = await (await import("../../apps/desktop/src/main/capabilities/runtime.js")).prepareCapabilities(fixture.paths);
  expect(preparedAfterRestart.selected).toEqual([]);
});
