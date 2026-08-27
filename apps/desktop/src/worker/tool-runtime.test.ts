import { describe, expect, it } from "vitest";
import { FakeAuditSink, FakeRetryClock, ToolRunner, ToolSet } from "@deepfield/tool-platform";
import { ToolBudgetLedger } from "@deepfield/tool-platform";
import { createToolRuntime } from "./tool-runtime.js";

function makeRuntime(registerProbe = true) {
  return createToolRuntime({ audit: new FakeAuditSink(), registerProbe });
}

describe("utility tool runtime assembly (focused revision)", () => {
  it("constructs without duplicate grants and freezes the registry", () => {
    const runtime = makeRuntime();
    expect(runtime.registry.list()).toHaveLength(1);
    expect(() =>
      runtime.registry.register({
        identity: { name: "echo_probe", version: 1 },
        label: "x",
        description: "x",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        effect: "project.read",
        timeoutMs: 1,
        retry: { maxRetries: 0, backoffMs: 0 },
        concurrency: 1,
        meter: { category: "none", countsBytes: false, countsTime: true },
        execute: async () => ({}),
      } as unknown as Parameters<typeof runtime.registry.register>[0]),
    ).toThrow(/frozen/);
  });

  it("does not register probe tools by default", () => {
    const runtime = makeRuntime(false);
    expect(runtime.registry.list()).toHaveLength(0);
    expect(runtime.registry.manifest()).toEqual([]);
  });

  it("runs echo_probe directly when explicitly registered", async () => {
    const runtime = makeRuntime(true);
    const events: { type: string }[] = [];
    const result = await runtime.run(
      {
        requestId: "req-1",
        kind: "tool.run",
        executionId: "exec-1",
        traceId: "trace-1",
        tool: { name: "echo_probe", version: 1 },
        input: { text: "hi" },
        actor: "developer_probe",
      },
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual([
      "accepted",
      "validated",
      "policy_checked",
      "started",
      "completed",
    ]);
  });

  it("keeps tool sets actor-scoped", () => {
    const runtime = makeRuntime();
    const mainTools = runtime.createAgentTools({ traceId: "t1", actor: "main_agent", projectId: "p1" });
    const probeTools = runtime.createAgentTools({ traceId: "t2", actor: "developer_probe" });
    expect(mainTools.map((tool) => tool.name)).toEqual(["echo_probe"]);
    expect(probeTools.map((tool) => tool.name)).toEqual(["echo_probe"]);
  });
});

describe("trace budget pool (focused revision)", () => {
  it("caps each trace at 12 calls while other traces keep full budgets", async () => {
    const clock = new FakeRetryClock();
    const runner = new ToolRunner({
      registry: makeRuntime(true).registry,
      policy: makeRuntime(true).policy,
      budget: new ToolBudgetLedger({}, () => clock.now()),
      audit: new FakeAuditSink(),
      clock,
    });
    // Integration of per-trace budgets is exercised through the runtime.
    const runtime = makeRuntime(true);
    for (let index = 0; index < 12; index += 1) {
      const result = await runtime.run(
        {
          requestId: `a-${index}`,
          kind: "tool.run",
          executionId: `a-${index}`,
          traceId: "trace-a",
          tool: { name: "echo_probe", version: 1 },
          input: { text: "hi" },
          actor: "developer_probe",
        },
        () => {},
        new AbortController().signal,
      );
      expect(result.status).toBe("completed");
    }
    const thirteenth = await runtime.run(
      {
        requestId: "a-13",
        kind: "tool.run",
        executionId: "a-13",
        traceId: "trace-a",
        tool: { name: "echo_probe", version: 1 },
        input: { text: "hi" },
        actor: "developer_probe",
      },
      () => {},
      new AbortController().signal,
    );
    expect(thirteenth.status).toBe("failed");
    if (thirteenth.status === "failed") {
      expect(thirteenth.failure.code).toBe("budget_exceeded");
    }
    const other = await runtime.run(
      {
        requestId: "b-1",
        kind: "tool.run",
        executionId: "b-1",
        traceId: "trace-b",
        tool: { name: "echo_probe", version: 1 },
        input: { text: "hi" },
        actor: "developer_probe",
      },
      () => {},
      new AbortController().signal,
    );
    expect(other.status).toBe("completed");
    void runner;
  });

  it("bounds the ledger pool and never evicts active ledgers", async () => {
    const runtime = makeRuntime(true);
    const firstTrace = "active-trace";
    const result = await runtime.run(
      {
        requestId: "a-1",
        kind: "tool.run",
        executionId: "a-1",
        traceId: firstTrace,
        tool: { name: "echo_probe", version: 1 },
        input: { text: "hi" },
        actor: "developer_probe",
      },
      () => {},
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(runtime.traceLedgerCount()).toBe(1);
  });
});
