import { afterEach, describe, expect, it } from "vitest";
import { configureTraceCollector, createTraceCollector, startTraceSpan } from "@deepfield/base/trace/runtime";
import type { TraceEvent } from "@deepfield/base/trace";
import { createWorkerMessageLoop } from "./message-loop.js";
import { InMemoryEndpoint, flushPending, request } from "./message-loop-test-helpers.js";
import { createWorkerTelemetryFlush } from "./shutdown.js";

afterEach(() => configureTraceCollector(undefined));
describe("production Worker telemetry shutdown", () => {
  it.each([false, true])("drains asynchronous abort cleanup before closing Trace (stalled=%s)", async stalled => {
    const events: TraceEvent[] = [];
    const trace = createTraceCollector(event => { events.push(event); }); configureTraceCollector(trace);
    const endpoint = new InMemoryEndpoint();
    let usageFlushed = false;
    const loop = createWorkerMessageLoop(endpoint, { async run(_request, _emit, signal) {
      const model = startTraceSpan("model", "req");
      await new Promise<void>(resolve => signal.addEventListener("abort", () => {
        if (!stalled) setTimeout(() => { model.end("cancelled", "aborted"); resolve(); }, 10);
      }, { once: true }));
    } }, { flushUsage: createWorkerTelemetryFlush({ async flush() { usageFlushed = true; } }, trace) });
    try {
      endpoint.emit({ ...request("req"), trace: { rootTraceId: "root", spanId: "main" } });
      await flushPending();
      endpoint.emit({ kind: "usage.flush", requestId: "shutdown" });
      for (let i = 0; i < 100 && !endpoint.posted.some(value => (value as { kind?: string }).kind === "usage.flushed"); i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(usageFlushed).toBe(true);
      expect(endpoint.posted).toContainEqual({ kind: "usage.flushed", requestId: "shutdown" });
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "span.end", kind: "worker", status: stalled ? "interrupted" : "cancelled" })]));
      if (!stalled) expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "span.end", kind: "model", status: "cancelled" })]));
      expect(trace.health().dropped).toBe(0);
    } finally { loop.dispose(); }
  });
});
