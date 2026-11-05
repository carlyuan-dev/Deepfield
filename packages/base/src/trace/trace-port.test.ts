import { afterEach, expect, it } from "vitest";
import { parseTraceEvent, type TraceEvent } from "./index.js";
import * as runtime from "./runtime.js";

afterEach(() => { runtime.configureTraceCollector(undefined); runtime.configureTraceLookup(undefined); });

it("accepts bounded async state and link events without accepting business payloads", () => {
  const base = { version: 1, eventId: "e", rootTraceId: "r", spanId: "s", requestId: "request", processSessionId: "p", sequence: 1, time: new Date().toISOString() };
  expect(parseTraceEvent({ ...base, type: "span.state", kind: "task", status: "queued", capabilityId: "company-research", taskId: "task" })).toMatchObject({ status: "queued" });
  expect(parseTraceEvent({ ...base, type: "span.link", links: [{ rootTraceId: "older", spanId: "previous" }] })).toMatchObject({ type: "span.link" });
  expect(() => parseTraceEvent({ ...base, type: "span.state", kind: "task", status: "queued", input: "SECRET" })).toThrow();
});

it("host-bound ports retain one context across detached callbacks and split every resume source into bounded links", async () => {
  const events: TraceEvent[] = [];
  const collector = runtime.createTraceCollector(event => { events.push(event); }); runtime.configureTraceCollector(collector);
  const port = (runtime as any).createTracePort("company-research");
  const task = port.start("task", "request", { taskId: "task" }, null);
  let execute!: () => unknown;
  port.run(task.context, () => { execute = () => port.run(task.context, () => port.start("stage", "raw", { runId: "run", stage: "raw" })); });
  const child = execute() as runtime.TraceSpan;
  port.link(child.context, Array.from({ length: 70 }, (_, index) => ({ rootTraceId: "previous", spanId: `span-${index}` })));
  child.end("succeeded"); task.end("succeeded");
  await collector.close();
  expect(events.find(event => event.type === "span.start" && event.spanId === child.context.spanId)).toMatchObject({ rootTraceId: task.context.rootTraceId, parentSpanId: task.context.spanId, capabilityId: "company-research" });
  const links = events.filter(event => event.type === "span.link");
  expect(links.flatMap(event => event.links ?? [])).toHaveLength(70);
  expect(links.every(event => (event.links?.length ?? 0) <= 32)).toBe(true);
  let calls = 0;
  expect(() => port.run(task.context, () => { calls++; throw new Error("business"); })).toThrow("business");
  expect(calls).toBe(1);
});

it("accepts portable stage identifiers and legacy artifact references within bounded event contracts", () => {
  const base = { version: 1, eventId: "e", rootTraceId: "r", spanId: "s", requestId: "request", processSessionId: "p", sequence: 1, time: new Date().toISOString(), type: "span.start", kind: "stage" };
  expect(parseTraceEvent({ ...base, stage: "document.render_v2", artifactId: "document:1" })).toMatchObject({ stage: "document.render_v2", artifactId: "document:1" });
  expect(parseTraceEvent({ ...base, stage: "raw", evidenceAttemptId: "legacy-attempt" })).toMatchObject({ evidenceAttemptId: "legacy-attempt" });
  for (const stage of ["", "private free text", "a".repeat(65)]) expect(() => parseTraceEvent({ ...base, stage })).toThrow("invalid_trace_event");
  expect(() => parseTraceEvent({ ...base, artifactId: "a".repeat(201) })).toThrow("invalid_trace_event");
});

it("keeps every searchable reference scoped to its capability in the memory index", () => {
  const port = runtime.createTracePort("documents");
  const other = runtime.createTracePort("images");
  const request = port.start("request", "lookup-request", {}, null);
  const interaction = port.start("interaction", "lookup-request", { interactionId: "lookup-interaction" }, request.context);
  expect(port.find({ kind: "request", id: "lookup-request" })).toEqual(request.context);
  expect(port.find({ kind: "interaction", id: "lookup-interaction" })).toEqual(interaction.context);
  expect(other.find({ kind: "request", id: "lookup-request" })).toBeUndefined();
  expect(runtime.findTrace({ kind: "interaction", id: "lookup-interaction" })).toBeUndefined();
});
