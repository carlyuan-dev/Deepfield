import { afterEach, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { configureTraceCollector, createTraceCollector, startTraceSpan, withTrace } from "@deepfield/base/trace/runtime";
import type { TraceEvent } from "@deepfield/base/trace";
import { actionFixture, testAction, testContext } from "./action-test-helpers.js";
afterEach(() => configureTraceCollector(undefined));
it("records one claimed action as accepted without claiming task completion on duplicate invocation", async () => {
  const events: TraceEvent[] = []; const collector = createTraceCollector(event => { events.push(event); }); configureTraceCollector(collector);
  let executions = 0;
  const fixture = await actionFixture(testAction({ requiresConfirmation: false, effects: { data: "read", consumesResources: false }, handler() { executions++; return { status: "accepted", taskRef: { capabilityId: "public-package", taskId: "task" }, taskStatus: "queued" }; } }));
  await fixture.start();
  try {
    const root = startTraceSpan("request", "request", {}, null);
    await withTrace(root.context, async () => {
      const context = fixture.runtime.actionGateway.issue(fixture.call, testContext);
      expect((await fixture.runtime.actionGateway.invoke(fixture.call, context)).status).toBe("accepted");
      expect((await fixture.runtime.actionGateway.invoke(fixture.call, context)).status).toBe("accepted");
    });
    await collector.close();
    expect(executions).toBe(1);
    expect(events.filter(event => event.type === "span.start" && event.kind === "action")).toHaveLength(1);
    expect(events.filter(event => event.type === "span.end" && event.kind === "action")).toMatchObject([{ status: "accepted" }]);
    expect(events.some(event => event.type === "span.end" && event.kind === "task")).toBe(false);
  } finally { await fixture.runtime.dispose(); await rm(fixture.root, { recursive: true, force: true }); }
});
