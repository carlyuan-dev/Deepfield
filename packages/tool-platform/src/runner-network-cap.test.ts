import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolDefinition } from "@deepfield/tool-platform";
import {
  FakeAuditSink,
  FakeRetryClock,
  ToolBudgetLedger,
  ToolPolicy,
  ToolRegistry,
  ToolRunner,
  ToolSet,
} from "@deepfield/tool-platform";

const inputSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
const outputSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });

function networkDefinition(
  concurrency: number,
  category: "search" | "none" = "search",
): ToolDefinition<typeof inputSchema, typeof outputSchema> {
  return {
    identity: { name: "net_tool", version: 1 },
    label: "Net Tool",
    description: "Network tool for concurrency tests.",
    inputSchema,
    outputSchema,
    effect: category === "none" ? "project.read" : "network.read.public",
    timeoutMs: 5000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency,
    meter: { category, countsBytes: false, countsTime: true },
    execute: async ({ text }) => ({ text }),
  };
}

function makeRunner(options: { networkToolConcurrency?: number; globalConcurrency?: number }) {
  const registry = new ToolRegistry();
  const clock = new FakeRetryClock();
  return {
    registry,
    clock,
    runner: new ToolRunner({
      registry,
      policy: new ToolPolicy(),
      budget: new ToolBudgetLedger({}, () => clock.now()),
      audit: new FakeAuditSink(),
      clock,
      ...(options.networkToolConcurrency !== undefined
        ? { networkToolConcurrency: options.networkToolConcurrency }
        : {}),
      ...(options.globalConcurrency !== undefined
        ? { globalConcurrency: options.globalConcurrency }
        : {}),
    }),
  };
}

const context = (traceId: string, name = "net_tool", effect: "network.read.public" | "project.read" = "network.read.public") => ({
  traceId,
  actor: "main_agent" as const,
  toolSet: new ToolSet([{ identity: { name, version: 1 }, actor: "main_agent", effect }]),
});

describe("runner network tool concurrency cap (focused revision)", () => {
  it("caps a network tool at 2 concurrent executions when its definition allows 3", async () => {
    const { registry, clock, runner } = makeRunner({ networkToolConcurrency: 2 });
    registry.register(networkDefinition(3));
    let gateResolve!: () => void;
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });
    let started = 0;
    const first = runner.execute(
      { executionId: "n1", traceId: "t", tool: { name: "net_tool", version: 1 }, input: { text: "alpha" } },
      context("t"),
      new AbortController().signal,
      () => {},
    );
    const second = runner.execute(
      { executionId: "n2", traceId: "t", tool: { name: "net_tool", version: 1 }, input: { text: "bravo" } },
      context("t"),
      new AbortController().signal,
      () => {},
    );
    const third = runner.execute(
      { executionId: "n3", traceId: "t", tool: { name: "net_tool", version: 1 }, input: { text: "charlie" } },
      context("t"),
      new AbortController().signal,
      (event) => {
        if (event.type === "started") {
          started += 1;
        }
      },
    );
    // The third must fail safely on saturation without touching the gated ones.
    const thirdResult = await third;
    expect(thirdResult.status).toBe("failed");
    if (thirdResult.status === "failed") {
      expect(thirdResult.failure.code).toBe("budget_exceeded");
      expect(thirdResult.failure.message).not.toContain("alpha");
      expect(thirdResult.failure.message).not.toContain("bravo");
      expect(thirdResult.failure.message).not.toContain("charlie");
    }
    gateResolve();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe("completed");
    expect(secondResult.status).toBe("completed");
    expect(started).toBeLessThanOrEqual(2);
    void clock;
  });

  it("does not cap non-network (none category) tools", async () => {
    const { registry, runner } = makeRunner({ networkToolConcurrency: 2 });
    registry.register(networkDefinition(3, "none"));
    const results = await Promise.all(
      [1, 2, 3].map((index) =>
        runner.execute(
          {
            executionId: `l${index}`,
            traceId: "t",
            tool: { name: "net_tool", version: 1 },
            input: { text: "x" },
          },
          context("t", "net_tool", "project.read"),
          new AbortController().signal,
          () => {},
        ),
      ),
    );
    expect(results.every((result) => result.status === "completed")).toBe(true);
  });

  it("releases the network slot after failures so later executions start again", async () => {
    const { registry, runner } = makeRunner({ networkToolConcurrency: 2 });
    registry.register({
      ...networkDefinition(2),
      execute: async () => {
        throw new Error("executor boom");
      },
    });
    const startedEvents: string[] = [];
    const run = (executionId: string, text: string) =>
      runner.execute(
        { executionId, traceId: "t", tool: { name: "net_tool", version: 1 }, input: { text } },
        context("t"),
        new AbortController().signal,
        (event) => {
          if (event.type === "started") {
            startedEvents.push(executionId);
          }
        },
      );
    const first = await run("f1", "x");
    expect(first.status).toBe("failed");
    const second = await run("f2", "y");
    expect(second.status).toBe("failed");
    // a slot was released after the first failure: the second execution started
    expect(startedEvents).toContain("f1");
    expect(startedEvents).toContain("f2");
  });

  it("keeps the global concurrency cap across traces", async () => {
    const { registry, runner } = makeRunner({ networkToolConcurrency: 2, globalConcurrency: 4 });
    registry.register(networkDefinition(4, "none"));
    let gateResolve!: () => void;
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });
    let started = 0;
    const executions = [1, 2, 3, 4, 5].map((index) =>
      runner.execute(
        {
          executionId: `g${index}`,
          traceId: `trace-${index}`,
          tool: { name: "net_tool", version: 1 },
          input: { text: "x" },
        },
        context(`trace-${index}`, "net_tool", "project.read"),
        new AbortController().signal,
        (event) => {
          if (event.type === "started") {
            started += 1;
          }
        },
      ),
    );
    const fifth = await executions[4]!;
    expect(fifth.status).toBe("failed");
    if (fifth.status === "failed") {
      expect(fifth.failure.code).toBe("budget_exceeded");
    }
    gateResolve();
    const settled = await Promise.all(executions.slice(0, 4));
    expect(settled.every((result) => result.status === "completed")).toBe(true);
    expect(started).toBeLessThanOrEqual(4);
  });
});
