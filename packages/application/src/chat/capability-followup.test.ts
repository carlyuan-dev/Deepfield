import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import { openTestDb, type TestDb } from "../testing/application-test-helpers.js";
import { ChatService } from "./chat-service.js";
import { ContextBuilder } from "./context-builder.js";
import { FakeWorker, makeSecrets } from "./chat-service-helpers.js";

const dbs: TestDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.cleanup(); });

describe("explicit capability follow-up", () => {
  it("restores conversation-owned task refs even with no enabled actions", async () => {
    const db = openTestDb(); dbs.push(db);
    const a = db.repos.conversations.create(); const b = db.repos.conversations.create();
    for (const [conversationId, taskId] of [[a.id, "approved-task"], [b.id, "other-task"]] as const)
      db.repos.chatCapabilities.linkTask({ conversationId, sourceRequestId: "approved", snapshot: { taskRef: { capabilityId: "probe", taskId }, status: "running" }, analyzeAfter: false, analysisState: "none" });
    const worker = new FakeWorker();
    const service = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("test"), worker, { capabilityDirectory: () => [] });
    await service.send(a.id, "取消刚才任务", "cancel", () => {});
    expect(worker.requests[0]?.context.systemPrompt).toContain("approved-task");
    expect(worker.requests[0]?.context.systemPrompt).not.toContain("other-task");
    expect(worker.requests[0]?.context.capabilityDirectory ?? []).toEqual([]);
    service.dispose();
  });

  it("reserves user input while profiles resolve so completion analysis cannot overtake it", async () => {
    const db = openTestDb(); dbs.push(db); const a = db.repos.conversations.create();
    db.repos.chatCapabilities.linkTask({ conversationId: a.id, sourceRequestId: "old", snapshot: { taskRef: { capabilityId: "probe", taskId: "task" }, status: "succeeded" }, analyzeAfter: true, analysisState: "pending" });
    const profiles = makeSecrets("test"); const original = profiles.resolveActiveLlm;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    profiles.resolveActiveLlm = async () => { await gate; return original(); };
    const worker = new FakeWorker({ neverEnds: true });
    const service = new ChatService(db.repos, new ContextBuilder(db.repos), profiles, worker, { capabilityDirectory: () => [{ capabilityId: "probe", capabilityName: "Probe", packageVersion: "1", actionId: "read", title: "Read", description: "Read", mode: "immediate", effects: { data: "read", consumesResources: false }, contractDigest: `sha256:${"a".repeat(64)}` }] });
    const sending = service.send(a.id, "new user input", "user", () => {});
    service.taskChanged(a.id); await new Promise(resolve => setTimeout(resolve, 300));
    release(); await sending; await new Promise(resolve => setTimeout(resolve, 0));
    expect(worker.requests.map(request => request.prompt)).toEqual(["new user input"]);
    service.dispose();
  });
  it("waits for its own visible conversation and streams one assistant answer without a synthetic user message", async () => {
    const db = openTestDb(); dbs.push(db);
    const a = db.repos.conversations.create(); const b = db.repos.conversations.create();
    const ref = { capabilityId: "probe", taskId: "task-1" };
    db.repos.chatCapabilities.linkTask({ conversationId: a.id, sourceRequestId: "original", snapshot: { taskRef: ref, status: "succeeded" }, analyzeAfter: true, analysisState: "pending" });
    let active = false;
    const events: Array<{ conversationId: string; event: AgentWorkerEvent }> = [];
    const worker = new FakeWorker({ events: request => [
      { requestId: request.requestId, type: "started" },
      { requestId: request.requestId, type: "text_delta", delta: "分析中" },
      { requestId: request.requestId, type: "completed", text: "分析完成" },
    ] });
    const service = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("sk-test"), worker, {
      capabilityDirectory: () => [{ capabilityId: "probe", capabilityName: "Probe", packageVersion: "1.0.0", actionId: "read",
        title: "Read", description: "Read", mode: "immediate", effects: { data: "read", consumesResources: false }, contractDigest: `sha256:${"a".repeat(64)}` }],
      isConversationActive: id => active && id === a.id,
      onAutoEvent: (conversationId, event) => events.push({ conversationId, event }),
    });
    service.taskChanged(a.id);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(worker.requests).toHaveLength(0);
    active = true; service.taskChanged(a.id);
    await vi.waitFor(() => expect(db.repos.chatCapabilities.tasks(a.id)[0]?.analysisState).toBe("completed"));
    expect(events.map(item => item.event.type)).toEqual(["started", "text_delta", "completed"]);
    expect(events.every(item => item.conversationId === a.id)).toBe(true);
    expect(db.repos.messages.listByConversation(a.id).map(item => item.role)).toEqual(["assistant"]);
    expect(db.repos.messages.listByConversation(b.id)).toEqual([]);
    service.dispose();
  });
});
