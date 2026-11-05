import { afterEach, expect, it, vi } from "vitest";
import { configureTraceCollector, createTraceCollector, startTraceSpan, withTrace } from "@deepfield/base/trace/runtime";
import type { TraceEvent } from "@deepfield/base/trace";
import { openTestDb } from "../../testing/application-test-helpers.js";
import { ChatInteractionCoordinator } from "./coordinator.js";
import { ChatService } from "../chat-service.js";
import { ContextBuilder } from "../context-builder.js";
import { FakeWorker, makeSecrets } from "../chat-service-helpers.js";
afterEach(() => configureTraceCollector(undefined));
it.each([false, true])("ends waiting and links every consumed response, including configuration failure=%s", async configurationFailure => {
  const db = openTestDb(); const events: TraceEvent[] = [];
  const collector = createTraceCollector(event => { events.push(event); }); configureTraceCollector(collector);
  const conversation = db.repos.conversations.create(); const coordinator = new ChatInteractionCoordinator(db.repos.chatInteractions, new Map());
  const worker = new FakeWorker(); const service = new ChatService(db.repos, new ContextBuilder(db.repos), makeSecrets(configurationFailure ? undefined : "key"), worker, { interactions: coordinator });
  try {
    for (const requestId of Array.from({ length: 40 }, (_, index) => `source-${index}`)) {
      const span = startTraceSpan("request", requestId, { conversationId: conversation.id }, null);
      await withTrace(span.context, async () => {
        const item = await coordinator.create({ conversationId: conversation.id, requestId, toolCallId: "ask" }, { kind: "question", question: "PRIVATE" });
        span.end("handed_off");
        await coordinator.respond({ interactionId: item.id, expectedRevision: item.revision, response: { kind: "answer", text: "PRIVATE" } }, { conversationId: conversation.id, source: "chat_button" });
      });
    }
    service.recoverInteractionResumes();
    await vi.waitFor(() => expect(db.repos.chatInteractions.pendingEvents()).toHaveLength(0));
    await collector.close();
    expect(worker.requests).toHaveLength(configurationFailure ? 0 : 1);
    const interactions = events.filter(event => event.type === "span.start" && event.kind === "interaction");
    expect(interactions).toHaveLength(40);
    const ended = events.filter(event => event.type === "span.end" && event.kind === "interaction");
    expect(ended).toHaveLength(40);
    expect(ended.every(event => event.type === "span.end" && event.status === "succeeded")).toBe(true);
    const resumed = events.find(event => event.type === "span.start" && event.kind === "request" && event.requestId.startsWith("interaction-resume:"))!;
    expect(resumed).toBeDefined();
    const links = events.filter(event => event.type === "span.link" && event.spanId === resumed.spanId).flatMap(event => event.links ?? []);
    expect(new Set(links.map(link => link.spanId))).toEqual(new Set(interactions.map(event => event.spanId)));
    if (configurationFailure) {
      expect(events.filter(event => event.type === "span.end" && event.spanId === resumed.spanId)).toMatchObject([{ status: "failed" }]);
      expect(events.some(event => event.type === "span.start" && event.kind === "model")).toBe(false);
    }
    expect(JSON.stringify(events)).not.toContain("PRIVATE");
  } finally { service.dispose(); db.cleanup(); }
});
