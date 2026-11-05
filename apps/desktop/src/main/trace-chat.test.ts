import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { configureTraceCollector, createTraceCollector, currentTrace } from "@deepfield/base/trace/runtime";
import type { TraceEvent } from "@deepfield/base/trace";
import { FakeAuditSink, FakeRetryClock, ToolBudgetLedger, ToolPolicy, ToolRegistry, ToolRunner, ToolSet } from "@deepfield/tool-platform";
import { createUsageRepository } from "@deepfield/base/usage/sqlite";
import { adoptDatabase } from "@deepfield/base/database/runtime";
import { ChatService } from "../../../../packages/application/src/chat/chat-service.js";
import { ContextBuilder } from "../../../../packages/application/src/chat/context-builder.js";
import { makeSecrets } from "../../../../packages/application/src/chat/chat-service-helpers.js";
import { openTestDb } from "../../../../packages/application/src/testing/application-test-helpers.js";
import { configureUsageRecorder } from "../shared/usage-collection.js";
import { createWorkerMessageLoop } from "../worker/message-loop.js";
import { createPiChatAgent } from "../worker/agent/pi-chat-agent.js";
import { createPiAgentTools } from "../worker/tools/pi-tool-adapter.js";
import { AgentWorkerClient } from "./agent-worker-client.js";
import { FakeEndpoint, request } from "./agent-worker-client-test-helpers.js";
import { InMemoryEndpoint, flushPending } from "../worker/message-loop-test-helpers.js";
import { openTraceStore } from "./trace-store.js";
import { exportTrace } from "../../../../scripts/trace/export.ts";

afterEach(() => { configureTraceCollector(undefined); configureUsageRecorder(undefined); vi.unstubAllGlobals(); });
function completion(tool = false) {
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "echo_probe", arguments: '{"text":"SECRET_SENTINEL"}' } }] } : { role: "assistant", content: "SECRET_SENTINEL final answer" };
  return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

describe("offline Chat Trace integration", () => {
  it("exports isolated successful and failed Chat/model/tool chains with exactly the existing Usage attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepfield-trace-chat-"));
    const store = openTraceStore(join(dir, "trace.sqlite"));
    const collector = createTraceCollector(event => store.record(event)); configureTraceCollector(collector);
    const db = openTestDb(); const usage = createUsageRepository(adoptDatabase(db.db).database); usage.initialize(new Date().toISOString());
    configureUsageRecorder({ recordStart: async value => { usage.upsert(value); return true; }, recordFinish: async value => { usage.upsert(value); return true; } });
    const counts = new Map<string, number>();
    vi.stubGlobal("fetch", async () => {
      const id = currentTrace()!.requestId;
      const count = (counts.get(id) ?? 0) + 1; counts.set(id, count);
      return id === "failed-request" ? new Response("SECRET_SENTINEL provider failure", { status: 503 }) : completion(count === 1);
    });
    const registry = new ToolRegistry();
    registry.register({ identity: { name: "echo_probe", version: 1 }, label: "Probe", description: "Offline", inputSchema: Type.Object({ text: Type.String() }), outputSchema: Type.Object({ text: Type.String() }), effect: "project.read", timeoutMs: 1000, retry: { maxRetries: 0, backoffMs: 0 }, concurrency: 2, meter: { category: "none", countsBytes: false, countsTime: false }, model: { formatOutput: value => value.text }, execute: async value => value });
    const budget = new ToolBudgetLedger({ maxCalls: 10 });
    const runner = new ToolRunner({ registry, policy: new ToolPolicy(), budget, audit: new FakeAuditSink(), clock: new FakeRetryClock() });
    const sessions = { createAgentTools: (context: { traceId: string }) => createPiAgentTools(registry, runner, { ...context, actor: "main_agent", toolSet: new ToolSet([{ identity: { name: "echo_probe", version: 1 }, actor: "main_agent", effect: "project.read" }]) }), bindSearchProvider() {}, budgetSnapshot: () => budget.snapshot(), recordSynthetic: async () => {}, releaseTrace: () => true };
    const parent = new FakeEndpoint(); const worker = new InMemoryEndpoint();
    parent.postMessage = value => worker.emit(value);
    worker.postMessage = value => parent.emit(value);
    const client = new AgentWorkerClient(parent);
    const loop = createWorkerMessageLoop(worker, createPiChatAgent(undefined, [], undefined, {}, sessions));
    const service = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets("SECRET_SENTINEL credential"), client);
    const outcomes = new Map<string, string>();
    const one = db.repos.conversations.create(); const two = db.repos.conversations.create();
    try {
      await Promise.all([[one.id, "success-request"], [two.id, "failed-request"]].map(([conversationId, requestId]) => service.send(conversationId!, "SECRET_SENTINEL prompt", requestId!, event => { if (["completed", "failed"].includes(event.type)) outcomes.set(event.requestId, event.type); })));
      await vi.waitFor(() => expect(outcomes.size).toBe(2));
      await collector.close();
      expect(outcomes.get("success-request")).toBe("completed"); expect(outcomes.get("failed-request")).toBe("failed");
      const rows = db.db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
      // Root correlation is carried explicitly on the production request envelope.
      const roots = new Map<string, string>();
      const traceDb = new (await import("node:sqlite")).DatabaseSync(join(dir, "trace.sqlite"), { readOnly: true });
      for (const row of traceDb.prepare("SELECT payload FROM trace_events WHERE kind='request' AND type='span.start'").all() as { payload: string }[]) { const event = JSON.parse(row.payload); roots.set(event.requestId, event.rootTraceId); }
      traceDb.close();
      expect(new Set(roots.values()).size).toBe(2);
      const good = exportTrace(join(dir, "trace.sqlite"), roots.get("success-request")!, rows.find(row => row.name === "main")!.file);
      const bad = exportTrace(join(dir, "trace.sqlite"), roots.get("failed-request")!, rows.find(row => row.name === "main")!.file);
      expect(good.spans.map(span => span.kind)).toEqual(expect.arrayContaining(["request", "worker", "model", "tool"]));
      expect(good.spans.every(span => span.status === "succeeded")).toBe(true);
      expect(bad.spans.some(span => span.kind === "model" && span.status === "failed")).toBe(true);
      expect(good.usage.attempts).toHaveLength(2); expect(bad.usage.attempts).toHaveLength(1);
      expect(good.events.every(event => event.requestId === "success-request")).toBe(true);
      expect(good.events.filter(event => event.type === "span.start" && event.kind === "model").every(event => "modelRequestId" in event)).toBe(true);
      expect(good.usage.attempts.every(attempt => attempt.status === "available")).toBe(true);
      expect(JSON.stringify([good, bad])).not.toContain("SECRET_SENTINEL");
      expect(Number((db.db.prepare("SELECT COUNT(*) AS n FROM usage_attempts").get() as { n: number }).n)).toBe(3);
    } finally { service.dispose(); loop.dispose(); client.dispose(); db.cleanup(); store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects foreign Worker trace roots and preserves business delivery when the trace callback rejects", async () => {
    const endpoint = new FakeEndpoint(); const received: unknown[] = [];
    const client = new AgentWorkerClient(endpoint, { trace: event => { received.push(event); return Promise.reject(new Error("sink down")); } });
    const stream = client.send({ ...request("req"), trace: { rootTraceId: "root", spanId: "main" } });
    const event = { version: 1, eventId: "e", rootTraceId: "foreign", spanId: "worker", parentSpanId: "main", type: "span.start", kind: "worker", requestId: "req", processSessionId: "session", sequence: 1, time: new Date().toISOString() };
    endpoint.emit({ kind: "trace.event", event });
    endpoint.emit({ kind: "trace.event", event: { ...event, rootTraceId: "root", prompt: "SECRET_SENTINEL" } });
    endpoint.emit({ kind: "trace.event", event: { ...event, rootTraceId: "root" } });
    endpoint.emit({ requestId: "req", type: "completed", text: "ok" });
    expect(received).toHaveLength(1);
    const events = []; for await (const value of stream) events.push(value);
    await flushPending(); expect(events.at(-1)?.type).toBe("completed"); client.dispose();
  });

  it.each(["no_terminal", "cancel", "dispose"] as const)("preserves the Worker %s boundary without inventing success", async mode => {
    const events: TraceEvent[] = []; const collector = createTraceCollector(event => { events.push(event); }); configureTraceCollector(collector);
    const endpoint = new InMemoryEndpoint();
    const loop = createWorkerMessageLoop(endpoint, { async run(_request, _emit, signal) {
      if (mode === "no_terminal") return;
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    endpoint.emit({ ...request("req"), trace: { rootTraceId: "root", spanId: "main" } });
    await flushPending();
    if (mode === "cancel") endpoint.emit({ kind: "usage.flush", requestId: "flush" });
    if (mode === "dispose") loop.dispose();
    await flushPending(); await collector.close();
    const ends = events.filter(event => event.type === "span.end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ status: mode === "no_terminal" ? "unknown" : mode === "cancel" ? "cancelled" : "interrupted" });
    loop.dispose();
  });
});
