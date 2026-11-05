import { expect, it } from "vitest";
import { configureTraceCollector, createTraceCollector, createTracePort, withTrace } from "@deepfield/base/trace/runtime";
import type { TraceEvent } from "@deepfield/base/trace";
import { ResearchQueueTrace } from "./research-trace.js";
import type { CompanyResearchBatchState } from "../contracts/index.js";

it("preserves partial failure and reopens parent and child when authentication pause resumes", async () => {
  const events: TraceEvent[] = []; const collector = createTraceCollector(event => { events.push(event); }); configureTraceCollector(collector);
  const port = createTracePort("company-research");
  const action = port.start("action", "request", { invocationId: "submit" }, null);
  const receipts = new Map([
    ["parent", JSON.stringify({ invocationId: "submit", entryIds: ["one", "two"] })],
    ["one", JSON.stringify({ invocationId: "child:parent:0", parentTaskId: "parent" })],
    ["two", JSON.stringify({ invocationId: "child:parent:1", parentTaskId: "parent" })],
  ]);
  const observer = new ResearchQueueTrace(port, id => receipts.get(id));
  const state: CompanyResearchBatchState = { batchId: "batch", itemId: "item", status: "running", total: 2, processed: 0, succeeded: 0, failed: 0,
    entries: ["one", "two"].map(id => ({ entryId: id, companyId: id, itemId: "item", status: "pending", input: { moduleIds: ["products_and_positioning"], asOfDate: "2026-09-21" } })) };
  try {
    withTrace(action.context, () => observer.observe(state));
    state.entries[0]!.status = "completed"; observer.observe(state);
    await new Promise(resolve => setImmediate(resolve));
    expect(events.some(event => event.type === "span.end" && event.taskId === "parent")).toBe(false);
    state.entries[1]!.status = "running"; observer.observe(state);
    // Production persists the failure before resetting the owned entry to
    // running and saving the authentication-paused queue.
    state.entries[1]!.status = "failed"; observer.observe(state);
    state.entries[1]!.status = "running"; state.status = "paused"; observer.observe(state);
    state.status = "running"; observer.observe(state);
    state.entries[1]!.status = "completed"; state.status = "completed"; observer.observe(state);
    action.end("accepted"); await collector.close();
    expect(events.find(event => event.type === "span.start" && event.taskId === "parent")).toMatchObject({ invocationId: "submit", parentSpanId: action.context.spanId });
    expect(events.filter(event => event.type === "span.end" && event.taskId === "parent")).toMatchObject([{ status: "failed" }, { status: "succeeded" }]);
    const parents = events.filter(event => event.type === "span.start" && event.taskId === "parent");
    expect(parents).toHaveLength(2);
    expect(parents[1]!.rootTraceId).toBe(parents[0]!.rootTraceId);
    expect(events.filter(event => event.type === "span.link" && event.spanId === parents[1]!.spanId).flatMap(event => event.links ?? []))
      .toContainEqual({ rootTraceId: parents[0]!.rootTraceId, spanId: parents[0]!.spanId });
    expect(events.filter(event => event.type === "span.state" && event.spanId === parents[1]!.spanId).map(event => event.type === "span.state" ? event.status : ""))
      .toEqual(["paused", "running"]);
    const resumedChild = events.filter(event => event.type === "span.start" && event.taskId === "two").at(-1)!;
    expect(resumedChild.parentSpanId).toBe(parents[1]!.spanId);
    expect(events.some(event => event.type === "coverage.gap")).toBe(false);
  } finally { observer.dispose(); port.dispose(); configureTraceCollector(undefined); }
});
