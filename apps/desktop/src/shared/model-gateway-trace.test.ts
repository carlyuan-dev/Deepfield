import { afterEach, expect, it, vi } from "vitest";
import { configureTraceCollector, createTraceCollector, startTraceSpan, withTrace } from "@deepfield/base/trace/runtime";
import type { TraceEvent } from "@deepfield/base/trace";
import { PiModelGateway } from "./model-gateway.js";
import { request } from "../main/agent-worker-client-test-helpers.js";
afterEach(() => { configureTraceCollector(undefined); vi.unstubAllGlobals(); });
it("traces each direct completion once and keeps provider success distinct from later validation failure", async () => {
  const events: TraceEvent[] = []; const collector = createTraceCollector(event => { events.push(event); }); configureTraceCollector(collector);
  vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "not-json" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
  const stage = startTraceSpan("stage", "structure", { stage: "structure", runId: "run" }, null);
  const gateway = new PiModelGateway();
  await withTrace(stage.context, async () => {
    expect(await gateway.completeText(request("structure").llm, "structure", "fixture")).toBe("not-json");
    expect((await gateway.completeTextResult(request("repair").llm, "repair", "fixture")).text).toBe("not-json");
  });
  stage.end("failed"); await collector.close();
  const starts = events.filter(event => event.type === "span.start" && event.kind === "model");
  expect(starts).toHaveLength(2);
  expect(starts.every(event => event.parentSpanId === stage.context.spanId)).toBe(true);
  expect(events.filter(event => event.type === "span.end" && event.kind === "model").every(event => event.type === "span.end" && event.status === "succeeded")).toBe(true);
  expect(new Set(events.filter(event => event.type === "usage.link").map(event => event.usageAttemptId)).size).toBe(2);
});
