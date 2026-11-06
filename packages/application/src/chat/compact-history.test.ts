import { expect, it } from "vitest";
import { ContextBuilder } from "./context-builder.js";
import { openTestDb } from "../testing/application-test-helpers.js";
import { restoreSessionContext, transcriptMessage } from "../../../../apps/desktop/src/worker/chat/pi-session-transcript.js";
import { assistant, stubModel } from "../../../../apps/desktop/src/worker/agent/pi-chat-agent-test-helpers.js";

it("restores the saved summary, kept tail and subsequent reply without replaying the compacted history", () => {
  const db = openTestDb();
  try {
    const conversation = db.repos.conversations.create();
    const old = { role: "user" as const, content: "最初目标Alpha", timestamp: 1 };
    const current = { role: "user" as const, content: "继续核验", timestamp: 2 };
    db.repos.messages.append(conversation.id, "user", old.content, "old");
    db.repos.messages.append(conversation.id, "assistant", "已创建", "old");
    db.repos.chatSessions.checkpoint(conversation.id, "old", "disabled", [old, transcriptMessage(assistant("已创建"))!]);
    db.repos.chatSessions.complete(conversation.id, "old");
    db.repos.messages.append(conversation.id, "user", current.content, "current");
    db.repos.chatSessions.checkpoint(conversation.id, "current", "disabled", [current]);
    db.repos.chatSessions.compact(conversation.id, "current", "disabled", {
      summary: "目标Alpha，已创建文件，待核验；不要重复创建。", retainedMessages: [current], sourceMessageCount: 1,
      createdAt: 3, tokensBefore: 2000, tokensAfter: 100,
    });
    db.repos.chatSessions.checkpoint(conversation.id, "current", "disabled", [current, transcriptMessage(assistant("核验成功"))!]);
    db.repos.chatSessions.complete(conversation.id, "current");
    db.repos.messages.append(conversation.id, "assistant", "核验成功", "current");
    const restored = restoreSessionContext(new ContextBuilder(db.repos).build(conversation.id), stubModel);
    expect(restored.messages[0]).toMatchObject({ role: "compactionSummary", summary: expect.stringContaining("不要重复创建") });
    expect(restored.messages.filter(m => m.role === "user")).toEqual([current]);
    expect(restored.messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "核验成功" }] });
    expect(db.repos.messages.listByConversation(conversation.id)).toHaveLength(4);
    expect(db.repos.chatSessions.list(conversation.id)[0]!.messages).toHaveLength(2);
  } finally { db.cleanup(); }
});
