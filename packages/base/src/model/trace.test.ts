import { afterEach, expect, it, vi } from "vitest";
import { createUsageCollector } from "../usage/runtime.js";
import { configureTraceCollector, createTraceCollector, startTraceSpan, withTrace } from "../trace/runtime.js";
import type { TraceEvent } from "../trace/index.js";
import { PiModelGateway, traceModelStream } from "./runtime.js";

afterEach(() => { configureTraceCollector(undefined); vi.unstubAllGlobals(); });
const snapshot = { id: "profile", name: "fixture", provider: "custom" as const, protocol: "openai_compatible" as const, baseUrl: "https://fixture.invalid", modelId: "fixture", contextWindow: 32000, apiKey: "secret" };
const response = () => new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });

it("records direct Base.Model stream and completion calls without a desktop wrapper", async () => {
  const events: TraceEvent[] = [];
  const collector = createTraceCollector(event => { events.push(event); }); configureTraceCollector(collector);
  let attempts = 0;
  const usage = createUsageCollector({ now: () => new Date().toISOString(), createId: () => `attempt-${++attempts}`, getRecorder: () => undefined });
  const gateway = new PiModelGateway({ usage, snapshotIdentity: () => ({}) });
  const root = startTraceSpan("task", "req", { taskId: "task" }, null);
  const observed: string[] = [];
  vi.stubGlobal("fetch", response);
  await withTrace(root.context, async () => {
    expect(await gateway.completeText(snapshot, "system", "prompt")).toBe("ok");
    const stream = gateway.createStream(snapshot, event => { observed.push(event.modelRequestId); });
    expect((await stream(gateway.createModel(snapshot), { messages: [] }, { apiKey: "secret", requestObservation: { requestId: "req", phase: "ordinary", origins: [] } }).result()).stopReason).toBe("stop");
  });
  root.end("succeeded"); await collector.close();
  const starts = events.filter((event): event is Extract<TraceEvent, { type: "span.start" }> => event.type === "span.start" && event.kind === "model");
  expect(starts).toHaveLength(2);
  expect(starts.every(event => event.parentSpanId === root.context.spanId)).toBe(true);
  expect(events.filter((event): event is Extract<TraceEvent, { type: "span.end" }> => event.type === "span.end" && event.kind === "model").map(event => event.status)).toEqual(["succeeded", "succeeded"]);
  const links = events.filter(event => event.type === "usage.link");
  expect(links).toHaveLength(2);
  expect(observed.length).toBeGreaterThan(0);
  expect(new Set(observed)).toEqual(new Set([starts[1]!.modelRequestId]));
  expect(links.map(event => event.modelRequestId)).toEqual(starts.map(event => event.modelRequestId));
});

it("preserves provider results and errors when the trace sink fails", async () => {
  const collector = createTraceCollector(() => { throw new Error("trace unavailable"); }); configureTraceCollector(collector);
  const gateway = new PiModelGateway({ usage: createUsageCollector({ now: () => new Date().toISOString(), createId: () => "attempt", getRecorder: () => undefined }), snapshotIdentity: () => ({}) });
  const root = startTraceSpan("task", "req", {}, null);
  vi.stubGlobal("fetch", response);
  expect(await withTrace(root.context, () => gateway.completeText(snapshot, "system", "prompt"))).toBe("ok");
  vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
  await expect(withTrace(root.context, () => gateway.completeText(snapshot, "system", "prompt"))).rejects.toThrow();
  await collector.close();
  expect(collector.health().failed).toBeGreaterThan(0);
});

it("keeps one span per call through a transparent wrapper with reused frozen options", async () => {
  const events: TraceEvent[] = []; let requests = 0;
  const collector = createTraceCollector(event => { events.push(event); }); configureTraceCollector(collector);
  const gateway = new PiModelGateway({ usage: createUsageCollector({ now: () => new Date().toISOString(), createId: () => `attempt-${requests}`, getRecorder: () => undefined }), snapshotIdentity: () => ({}) });
  const base = gateway.createStream(snapshot);
  const forward: typeof base = (model, context, options) => base(model, context, { ...options });
  const outer = traceModelStream(traceModelStream(forward, { requestId: "req", phase: "ordinary" }), { turn: 2 });
  const options = Object.freeze({ apiKey: "secret", fetch: async () => { requests++; return response(); } });
  await Promise.all([1, 2].map(() => outer(gateway.createModel(snapshot), { messages: [] }, options).result()));
  await collector.close();
  expect(requests).toBe(2);
  expect(Reflect.ownKeys(options)).toEqual(["apiKey", "fetch"]);
  const starts = events.filter(event => event.type === "span.start" && event.kind === "model");
  expect(starts).toHaveLength(2);
  expect(starts).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: "req", phase: "ordinary", turn: 2 })]));
  expect(new Set(starts.map(event => event.spanId)).size).toBe(2);
  expect(events.filter(event => event.type === "span.end" && event.kind === "model")).toHaveLength(2);
});
