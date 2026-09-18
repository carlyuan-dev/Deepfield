import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import { ContextBuilder } from "@deepfield/application";
import { createPiChatAgent } from "./pi-chat-agent.js";
import { assistant, capture, makeRecordingInstalledPiRuntime, request } from "./pi-chat-agent-test-helpers.js";
import { transcriptMessage } from "./pi-session-transcript.js";

describe("persistent Pi Chat transcript", () => {
  it("allowlists native fields without credentials, hidden reasoning or signatures", () => {
    const native = assistant("", { content: [
      { type: "thinking", thinking: "private reasoning", thinkingSignature: "private signature" },
      { type: "text", text: "visible", textSignature: "private signature" },
      { type: "toolCall", id: "call", name: "web_search", arguments: { query: "valid", apiKey: "private key", headers: { Authorization: "private bearer" } } },
    ] });
    const encoded = JSON.stringify(transcriptMessage(native));
    expect(encoded).toContain("visible"); expect(encoded).toContain("valid");
    expect(encoded).not.toContain("private"); expect(encoded).not.toContain("headers");
  });
  it("retains paired normalized evidence through SQLite reload for an offline real-Pi request", async () => {
    const sourceUrl = "https://example.test/original?a=1&b=2";
    const online = makeRecordingInstalledPiRuntime([
      assistant("", { content: [{ type: "toolCall", id: "search-1", name: "web_search", arguments: { query: "original query" } }], stopReason: "toolUse" }),
      assistant("查到来源。"),
    ]);
    const dim = { limit: 4, remaining: 3, consumed: 1, reserved: 0, exhausted: false };
    const sessions = {
      createAgentTools: () => [{ name: "web_search", label: "search", description: "search", parameters: Type.Object({ query: Type.String() }), execute: async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ results: [{ title: "Original source", url: sourceUrl, snippet: "Evidence" }] }) }], details: { apiKey: "must-not-persist", headers: { Authorization: "must-not-persist" }, budgetConsumed: true } }) }],
      bindSearchProvider: () => undefined, budgetSnapshot: () => ({ total: dim, categories: { search: dim, fetch: dim, parse: dim, link_check: dim, none: dim } }), recordSynthetic: async () => undefined, releaseTrace: () => true,
    };
    const run = await capture(createPiChatAgent(online.runtime, [], undefined, {}, sessions, undefined, () => ({} as never)), undefined, request({ webSearch: true }));
    expect(run.error).toBeUndefined();
    const checkpoints = run.events.filter(e => e.type === "transcript_checkpoint");
    expect(checkpoints.length).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), "deepfield-session-"));
    const dbPath = join(dir, "session.sqlite");
    let db = openDatabase(dbPath); migrate(db);
    try {
      const repos = createRepositories(db); const conversation = repos.conversations.create();
      repos.messages.append(conversation.id, "user", "当前问题", "req-1");
      repos.messages.append(conversation.id, "assistant", "查到来源。", "req-1");
      for (const event of run.events) {
        if (event.type === "transcript_checkpoint") repos.chatSessions.checkpoint(conversation.id, "req-1", "enabled", event.messages);
        if (event.type === "tool_activity") repos.chatSessions.activity(conversation.id, "req-1", "enabled", event);
      }
      repos.chatSessions.complete(conversation.id, "req-1");
      db.close(); db = openDatabase(dbPath); migrate(db);
      const reloaded = createRepositories(db);
      const context = new ContextBuilder(reloaded).build(conversation.id);
      const saved = reloaded.chatSessions.list(conversation.id)[0]!;
      expect(JSON.stringify(saved)).not.toContain("must-not-persist");
      expect(saved.activities[0]).toMatchObject({ queryOrUrl: "original query", sources: [{ title: "Original source", url: sourceUrl }], status: "completed" });
      const offline = makeRecordingInstalledPiRuntime([assistant("沿用此前来源。")]);
      await capture(createPiChatAgent(offline.runtime, sessions.createAgentTools()), undefined, { ...request(), requestId: "req-offline", context });
      const sent = offline.requests[0]!;
      expect(sent.tools.some(t => t.name === "web_search")).toBe(false);
      expect(sent.messages.some(m => m.role === "toolResult" && JSON.stringify(m).includes(sourceUrl))).toBe(true);
      expect(sent.messages.filter(m => m.role === "user" && JSON.stringify(m.content).includes("当前问题"))).toHaveLength(2);
      expect(sent.systemPrompt).toContain("network=enabled");
      expect(sent.systemPrompt).toContain("successfulNetworkResults=1");
      reloaded.conversations.delete(conversation.id);
      expect(reloaded.chatSessions.list(conversation.id)).toEqual([]);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
