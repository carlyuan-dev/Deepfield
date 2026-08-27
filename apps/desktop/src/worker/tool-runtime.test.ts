import { describe, expect, it } from "vitest";
import { FakeAuditSink, FakeRetryClock, ToolRunner, ToolSet } from "@deepfield/tool-platform";
import { ToolBudgetLedger } from "@deepfield/tool-platform";
import { createToolRuntime, TraceBudgetPool } from "./tool-runtime.js";

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

describe("trace budget pool lifecycle (focused revision)", () => {
  it("refuses a new trace when at capacity with no releasable entry", () => {
    const pool = new TraceBudgetPool({ limits: { maxCalls: 12 }, maxTraces: 1, clock: () => 0 });
    const first = pool.ledgerFor("a");
    first.reserve({ name: "echo", version: 1 }, "none");
    expect(pool.size()).toBe(1);
    expect(() => pool.ledgerFor("b")).toThrow(/max traces/);
    expect(pool.size()).toBe(1);
    expect(pool.has("a")).toBe(true);
  });

  it("keeps unreleased traces capped and only resets after releaseTrace", () => {
    const pool = new TraceBudgetPool({ limits: { maxCalls: 2 }, maxTraces: 64, clock: () => 0 });
    const identity = { name: "echo", version: 1 };
    const a = pool.ledgerFor("a");
    const firstToken = a.reserve(identity, "none");
    const secondToken = a.reserve(identity, "none");
    a.complete(firstToken);
    a.complete(secondToken);
    expect(() => a.reserve(identity, "none")).toThrow(/max calls/);
    pool.ledgerFor("b");
    pool.ledgerFor("c");
    expect(pool.has("a")).toBe(true);
    expect(() => pool.ledgerFor("a").reserve(identity, "none")).toThrow(/max calls/);
    expect(pool.releaseTrace("a")).toBe(true);
    expect(pool.has("a")).toBe(false);
    expect(() => pool.ledgerFor("a").reserve(identity, "none")).not.toThrow();
  });

  it("refuses releaseTrace while the trace has in-flight tokens", () => {
    const pool = new TraceBudgetPool({ limits: {}, maxTraces: 4, clock: () => 0 });
    const a = pool.ledgerFor("a");
    a.reserve({ name: "echo", version: 1 }, "none");
    expect(pool.releaseTrace("a")).toBe(false);
    expect(pool.has("a")).toBe(true);
    expect(pool.size()).toBeLessThanOrEqual(4);
  });
});
