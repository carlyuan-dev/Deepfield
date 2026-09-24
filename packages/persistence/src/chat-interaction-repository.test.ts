import { describe, expect, it } from "vitest";
import { createRepositories, migrate, openDatabase } from "./index.js";

const owner = (conversationId: string) => ({ conversationId, requestId: "request", toolCallId: "tool" });
const approval = { kind: "approval" as const, summary: "Create item", operation: { provider: "fake", operationId: "create", contractVersion: "1", draftRef: "draft" } };

describe("chat interaction persistence", () => {
  it("enforces one pending interaction per conversation and isolates other conversations", () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db); const a = repos.conversations.create(); const b = repos.conversations.create();
      const first = repos.chatInteractions.create(owner(a.id), approval, "opaque-a");
      expect(() => repos.chatInteractions.create(owner(a.id), { kind: "question", question: "Which?" })).toThrow();
      expect(repos.chatInteractions.create(owner(b.id), approval, "opaque-b").status).toBe("waiting");
      expect(repos.chatInteractions.active(a.id)?.id).toBe(first.id);
      expect(repos.chatInteractions.list(a.id)).toHaveLength(1);
      expect(repos.chatInteractions.list(b.id)).toHaveLength(1);
    } finally { db.close(); }
  });

  it("claims one approval and one receipt atomically, then emits one durable result event", () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db); const conversation = repos.conversations.create();
      const item = repos.chatInteractions.create(owner(conversation.id), approval, "opaque-v1");
      expect(repos.chatInteractions.claimApproval(item.id, item.revision + 1, "bad", "chat_button")).toBeUndefined();
      expect(repos.chatInteractions.claimApproval(item.id, item.revision, "receipt-1", "chat_button")?.status).toBe("executing");
      expect(repos.chatInteractions.claimApproval(item.id, item.revision, "receipt-2", "form_button")).toBeUndefined();
      expect(repos.chatInteractions.finishExecution(item.id, "receipt-1", { status: "submitted", summary: "Queued", taskId: "task-1" })?.status).toBe("submitted");
      expect(repos.chatInteractions.finishExecution(item.id, "receipt-1", { status: "succeeded", summary: "Done" })).toBeUndefined();
      expect(repos.chatInteractions.pendingEvents(conversation.id)).toMatchObject([{ kind: "operation_result", detail: "Queued" }]);
      const resume = repos.chatInteractions.pendingEvents(conversation.id)[0]!;
      expect(repos.chatInteractions.claimEvent(resume.id)?.state).toBe("claimed");
      expect(repos.chatInteractions.claimEvent(resume.id)).toBeUndefined();
      repos.chatInteractions.consumeEvent(resume.id);
      expect(repos.chatInteractions.pendingEvents(conversation.id)).toEqual([]);
    } finally { db.close(); }
  });

  it("locks approval during editing and cascades records on conversation deletion", () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db); const conversation = repos.conversations.create();
      const item = repos.chatInteractions.create(owner(conversation.id), approval, "opaque-v1");
      const editing = repos.chatInteractions.beginEdit(item.id, item.revision)!;
      expect(editing.status).toBe("editing");
      expect(repos.chatInteractions.claimApproval(item.id, item.revision, "receipt", "chat_button")).toBeUndefined();
      expect(repos.chatInteractions.claimApproval(item.id, editing.revision, "receipt", "chat_button")).toBeUndefined();
      const waiting = repos.chatInteractions.finishEdit(item.id, editing.revision, { version: "opaque-v2", summary: "Updated" })!;
      expect(waiting).toMatchObject({ revision: item.revision + 2, contentVersion: "opaque-v2", status: "waiting" });
      repos.conversations.delete(conversation.id);
      expect(repos.chatInteractions.get(item.id)).toBeUndefined();
    } finally { db.close(); }
  });
});
