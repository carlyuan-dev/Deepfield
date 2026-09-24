import { describe, expect, it, vi } from "vitest";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import { ChatInteractionCoordinator } from "./coordinator.js";
import type { OperationAdapter } from "./ports.js";

const operation = { provider: "fake", operationId: "create", contractVersion: "1", draftRef: "draft" };
const approval = { kind: "approval" as const, summary: "Create item", operation };
const owner = (conversationId: string) => ({ conversationId, requestId: "request", toolCallId: "tool" });
const context = (conversationId: string) => ({ conversationId, source: "chat_button" as const });

describe("ChatInteractionCoordinator", () => {
  it("executes a simultaneous left and right approval only once", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db); const conversation = repos.conversations.create();
      const execute = vi.fn(async () => ({ status: "succeeded" as const, summary: "Created" }));
      const adapter: OperationAdapter = { read: async () => ({ version: "v1", summary: "Create item" }), execute, reconcile: async () => "unknown" };
      const changed = vi.fn();
      const coordinator = new ChatInteractionCoordinator(repos.chatInteractions, new Map([["fake", adapter]]), changed);
      const item = await coordinator.create(owner(conversation.id), approval);
      const command = { interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision" as const, decision: "approve" as const } };
      await Promise.all([coordinator.respond(command, context(conversation.id)), coordinator.respond(command, { conversationId: conversation.id, source: "form_button" })]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(operation, item.revision, expect.any(String), "v1");
      expect(coordinator.get(item.id)?.status).toBe("succeeded");
      expect(repos.chatInteractions.pendingEvents(conversation.id)).toHaveLength(1);
      expect(changed).toHaveBeenCalledWith(expect.objectContaining({ status: "executing" }));
    } finally { db.close(); }
  });

  it("keeps answers separate from approval and binds responses to the original conversation", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db); const a = repos.conversations.create(); const b = repos.conversations.create();
      const execute = vi.fn();
      const coordinator = new ChatInteractionCoordinator(repos.chatInteractions, new Map([["fake", { read: async () => ({ version: "v1", summary: "Create item" }), execute, reconcile: async () => "unknown" } as OperationAdapter]]));
      const question = await coordinator.create(owner(a.id), { kind: "question", question: "Choose", options: [{ id: "yes", label: "Agree" }] });
      await expect(coordinator.respond({ interactionId: question.id, expectedRevision: 1, response: { kind: "decision", decision: "approve" } }, context(a.id))).rejects.toThrow("Question answers never approve");
      await expect(coordinator.respond({ interactionId: question.id, expectedRevision: 1, response: { kind: "answer", text: "Agree" } }, context(b.id))).rejects.toThrow("another conversation");
      expect((await coordinator.respond({ interactionId: question.id, expectedRevision: 1, response: { kind: "answer", text: "Agree" } }, context(a.id))).status).toBe("answered");
      expect(execute).not.toHaveBeenCalled();
      expect(repos.chatInteractions.pendingEvents(a.id)).toHaveLength(1);
      expect(repos.chatInteractions.pendingEvents(b.id)).toHaveLength(0);
    } finally { db.close(); }
  });

  it("rejects stale approval while editing and refreshes opaque draft binding", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db); const conversation = repos.conversations.create();
      const execute = vi.fn(async () => ({ status: "succeeded" as const, summary: "Created" }));
      const adapter: OperationAdapter = { read: async ref => ({ version: ref.draftRef === "draft-2" ? "opaque-2" : "opaque-1", summary: "Create item" }), execute, reconcile: async () => "unknown" };
      const coordinator = new ChatInteractionCoordinator(repos.chatInteractions, new Map([["fake", adapter]]));
      const item = await coordinator.create(owner(conversation.id), approval);
      const editing = coordinator.beginEdit(item.id, item.revision);
      expect((await coordinator.respond({ interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision", decision: "approve" } }, context(conversation.id))).status).toBe("editing");
      const waiting = await coordinator.completeEdit(item.id, editing.revision, { ...operation, draftRef: "draft-2" });
      expect(waiting).toMatchObject({ status: "waiting", revision: 3, contentVersion: "opaque-2", payload: { operation: { draftRef: "draft-2" } } });
      await coordinator.respond({ interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision", decision: "approve" } }, context(conversation.id));
      expect(execute).not.toHaveBeenCalled();
    } finally { db.close(); }
  });

  it("reconciles an in-flight receipt on restart without replaying execution", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db); const conversation = repos.conversations.create();
      const item = repos.chatInteractions.create(owner(conversation.id), approval, "v1");
      repos.chatInteractions.claimApproval(item.id, 1, "receipt", "chat_button");
      const execute = vi.fn(); const reconcile = vi.fn(async () => "unknown" as const);
      const adapter: OperationAdapter = { read: async () => ({ version: "v1", summary: "Create item" }), execute, reconcile };
      const coordinator = new ChatInteractionCoordinator(repos.chatInteractions, new Map([["fake", adapter]]));
      expect((await coordinator.recover())[0]?.status).toBe("uncertain");
      expect(reconcile).toHaveBeenCalledWith("receipt");
      expect(execute).not.toHaveBeenCalled();
      expect(repos.chatInteractions.pendingEvents(conversation.id)).toHaveLength(1);
    } finally { db.close(); }
  });

  it("cancels an editing draft and releases it without execution", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db); const conversation = repos.conversations.create();
      const release = vi.fn(async () => {}); const execute = vi.fn();
      const adapter: OperationAdapter = { read: async () => ({ version: "v1", summary: "Create item" }), execute, reconcile: async () => "unknown", release };
      const coordinator = new ChatInteractionCoordinator(repos.chatInteractions, new Map([["fake", adapter]]));
      const item = await coordinator.create(owner(conversation.id), approval);
      const editing = coordinator.beginEdit(item.id, item.revision);
      const cancelled = await coordinator.respond({ interactionId: item.id, expectedRevision: editing.revision, response: { kind: "decision", decision: "cancel" } }, context(conversation.id));
      expect(cancelled.status).toBe("cancelled");
      expect(release).toHaveBeenCalledWith(operation);
      expect(execute).not.toHaveBeenCalled();
      expect(repos.chatInteractions.pendingEvents(conversation.id)).toHaveLength(1);
    } finally { db.close(); }
  });

  it("does not let a throwing change listener strand a claimed operation", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db); const conversation = repos.conversations.create();
      const execute = vi.fn(async () => ({ status: "succeeded" as const, summary: "Created" }));
      const adapter: OperationAdapter = { read: async () => ({ version: "v1", summary: "Create item" }), execute, reconcile: async () => "unknown" };
      const coordinator = new ChatInteractionCoordinator(repos.chatInteractions, new Map([["fake", adapter]]), () => { throw new Error("renderer unavailable"); });
      const item = await coordinator.create(owner(conversation.id), approval);
      expect((await coordinator.respond({ interactionId: item.id, expectedRevision: 1, response: { kind: "decision", decision: "approve" } }, context(conversation.id))).status).toBe("succeeded");
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });

  it("refreshes changed provider content and requires a new approval revision", async () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db); const conversation = repos.conversations.create();
      let version = "v1";
      const execute = vi.fn();
      const adapter: OperationAdapter = { read: async () => ({ version, summary: "Create item" }), execute, reconcile: async () => "unknown" };
      const coordinator = new ChatInteractionCoordinator(repos.chatInteractions, new Map([["fake", adapter]]));
      const item = await coordinator.create(owner(conversation.id), approval);
      version = "v2";
      const refreshed = await coordinator.respond({ interactionId: item.id, expectedRevision: item.revision, response: { kind: "decision", decision: "approve" } }, context(conversation.id));
      expect(refreshed).toMatchObject({ status: "waiting", revision: 3, contentVersion: "v2" });
      expect(execute).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});
