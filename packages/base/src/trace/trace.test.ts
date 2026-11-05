import { describe, expect, it } from "vitest";
import { parseTraceEvent } from "./index.js";
import { createTraceCollector, createTracePort, currentTrace, withTrace } from "./runtime.js";

const event = { version: 1, eventId: "event-1", rootTraceId: "root-1", spanId: "span-1", processSessionId: "process-1", sequence: 1, time: "2026-10-21T00:00:00.000Z", type: "span.start", kind: "request", requestId: "request-1" };
describe("Trace safety boundary", () => {
  it("explicitly clears an inherited scope and invokes undefined-returning work exactly once", async () => {
    const scope = { rootTraceId: "outer", spanId: "outer-span", requestId: "outer-request" };
    let calls = 0; const port = createTracePort();
    await withTrace(scope, async () => {
      await withTrace(undefined, async () => { calls++; await Promise.resolve(); expect(currentTrace()).toBeUndefined(); });
      expect(currentTrace()).toEqual(scope);
      port.run(undefined, () => { calls++; expect(currentTrace()).toBeUndefined(); });
      port.dispose(); port.run(scope, () => { calls++; expect(currentTrace()).toBeUndefined(); });
      expect(currentTrace()).toEqual(scope);
    });
    expect(calls).toBe(3); expect(currentTrace()).toBeUndefined();
  });
  it("rejects unknown fields and invalid states instead of retaining sensitive content", () => {
    expect(parseTraceEvent(event)).toEqual(event);
    expect(() => parseTraceEvent({ ...event, prompt: "SECRET_SENTINEL" })).toThrow();
    expect(() => parseTraceEvent({ ...event, type: "span.end", status: "SECRET_SENTINEL" })).toThrow();
  });
  it("bounds stalled delivery and absorbs synchronous and asynchronous sink failures", async () => {
    let deliveries = 0;
    const stalled = createTraceCollector(() => { deliveries++; return new Promise(() => {}); }, { capacity: 2, timeoutMs: 5 });
    for (let i = 0; i < 5; i++) stalled.emit({ ...event, eventId: `event-${i}` });
    await stalled.close(20);
    expect(stalled.health().dropped).toBeGreaterThanOrEqual(3);
    expect(stalled.health().pending).toBe(0);
    expect(deliveries).toBe(1);
    for (const sink of [() => { throw new Error("SECRET_SENTINEL"); }, () => Promise.reject(new Error("SECRET_SENTINEL"))]) {
      const collector = createTraceCollector(sink);
      collector.emit(event);
      await collector.close(100);
      expect(collector.health().failed).toBe(1);
      expect(JSON.stringify(collector.health())).not.toContain("SECRET_SENTINEL");
    }
  });
});
