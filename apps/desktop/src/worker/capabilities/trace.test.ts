import { afterEach, expect, it } from "vitest";
import { Type } from "typebox";
import { configureTraceCollector, createTraceCollector, currentTrace } from "@deepfield/base/trace/runtime";
import type { TraceEvent } from "@deepfield/base/trace";
import { WorkerCapabilityRegistry } from "./registry.js";
afterEach(() => configureTraceCollector(undefined));
it("restores host context through a portable capability handler and records its actual terminal", async () => {
  const events: TraceEvent[] = []; const collector = createTraceCollector(event => { events.push(event); }); configureTraceCollector(collector);
  const output: unknown[] = []; const registry = new WorkerCapabilityRegistry(event => output.push(event));
  const registrar = registry.begin("portable"); let context: unknown;
  registrar.register("run", Type.Null(), Type.Null(), async (_input, emit) => { await Promise.resolve(); context = currentTrace(); emit(null, "failed"); }); registrar.ready();
  expect(registry.handle({ kind: "capability.run", capabilityId: "portable", operation: "run", requestId: "request", input: null, trace: { rootTraceId: "root", spanId: "stage" } })).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 0)); await collector.close();
  expect(context).toMatchObject({ rootTraceId: "root", requestId: "request" });
  expect(events.find(event => event.type === "span.start")).toMatchObject({ kind: "worker", parentSpanId: "stage" });
  expect(events.find(event => event.type === "span.end")).toMatchObject({ status: "failed" });
  expect(output).toHaveLength(1); await registry.dispose();
});
