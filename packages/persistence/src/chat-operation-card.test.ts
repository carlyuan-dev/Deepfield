import { describe, expect, it } from "vitest";
import { createRepositories, migrate, openDatabase } from "./index.js";

describe("Chat operation card receipts", () => {
  it("keeps a resolved card on its initiating request and interrupts stale confirmation without resurrecting it", () => {
    const db = openDatabase(":memory:"); migrate(db);
    try {
      const repos = createRepositories(db);
      const conversation = repos.conversations.create();
      repos.chatCapabilities.saveOperation({ conversationId: conversation.id, sourceRequestId: "request-1", invocationId: "inv-1",
        status: "awaiting_confirmation", title: "新建主题", presentation: { text: "预览主题" } });
      expect(repos.chatCapabilities.operations(conversation.id)).toMatchObject([{ sourceRequestId: "request-1", status: "awaiting_confirmation" }]);
      repos.chatCapabilities.interruptPendingOperations();
      expect(repos.chatCapabilities.operations(conversation.id)).toMatchObject([{ sourceRequestId: "request-1", status: "interrupted" }]);
      repos.chatCapabilities.saveOperation({ conversationId: conversation.id, sourceRequestId: "request-1", invocationId: "inv-1",
        status: "completed", title: "新建主题", presentation: { text: "已创建主题" } });
      expect(repos.chatCapabilities.operations(conversation.id)).toMatchObject([{ sourceRequestId: "request-1", status: "completed", presentation: { text: "已创建主题" } }]);
    } finally { db.close(); }
  });
});
