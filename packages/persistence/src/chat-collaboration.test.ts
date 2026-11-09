import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrations.js";
import { createRepositories } from "./repositories.js";
import type { ChatCollaborationState } from "@deepfield/contracts";

describe("durable Chat collaboration", () => {
  it("keeps child results separate from the parent's transcript and rejects stale checkpoints", () => {
    const db = new DatabaseSync(":memory:"); migrate(db);
    try {
      const r = createRepositories(db), conversation = r.conversations.create();
      const state: ChatCollaborationState = { version: 1, scopeId: "scope", rootRequestId: "parent", revision: 2,
        status: "running", snapshot: "{}", modelCalls: 3, remainingMs: 500000, searchConsumed: 0,
        fetchConsumed: 0, resultCursor: 0, tasks: [{ taskId: "t", runId: "r", title: "核实", instruction: "核实材料",
          status: "completed", sequence: 1, result: "发现了两个差异" }] };
      r.chatSessions.checkpoint(conversation.id, "parent", "disabled", []);
      r.chatSessions.collaboration(conversation.id, "parent", "disabled", state);
      const restored = createRepositories(db).chatSessions.list(conversation.id)[0]!;
      expect(restored.collaboration?.tasks[0]?.result).toBe("发现了两个差异");
      expect(restored.completed).toBe(false);
      expect(restored.messages).toEqual([]);
      expect(r.messages.listByConversation(conversation.id)).toEqual([]);
      expect(() => r.chatSessions.collaboration(conversation.id, "parent", "disabled", { ...state, revision: 1 })).toThrow();
      expect(r.chatSessions.list(conversation.id)[0]?.collaboration?.revision).toBe(2);
      r.conversations.delete(conversation.id);
      expect(r.chatSessions.list(conversation.id)).toEqual([]);
    } finally { db.close(); }
  });
});
