import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolExecutionResult } from "@deepfield/contracts";
import type {
  ToolDefinition,
  ToolEffect,
  ToolMeterCategory,
} from "@deepfield/tool-platform";
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

function definition(options: {
  name?: string;
  effect: ToolEffect;
  category: ToolMeterCategory;
  concurrency: number;
  execute?: ToolDefinition<typeof inputSchema, typeof outputSchema>["execute"];
}): ToolDefinition<typeof inputSchema, typeof outputSchema> {
  return {
    identity: { name: options.name ?? "net_tool", version: 1 },
    label: "Tool",
    description: "test tool",
    inputSchema,
    outputSchema,
    effect: options.effect,
    timeoutMs: 5000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: options.concurrency,
    meter: { category: options.category, countsBytes: false, countsTime: true },
    execute: options.execute ?? (async ({ text }) => ({ text })),
  };
}

/**
 * Controllable gate: executors genuinely await the gate after started, so a
 * test can prove N calls are in flight before starting the rejected call.
 */
function makeGate(): {
  executor: ToolDefinition<typeof inputSchema, typeof outputSchema>["execute"];
  enteredCount(): number;
  waitEntered(n: number): Promise<void>;
  release(): void;
} {
  let release!: () => void;
  const gatePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered: string[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  const check = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (entered.length >= waiter.n) {
        waiter.resolve();
        waiters.splice(index, 1);
      }
    }
  };
  return {
    executor: async ({ text }) => {
      entered.push(text);
      check();
      await gatePromise;
      return { text: `ok:${text}` };
    },
    enteredCount: () => entered.length,
    waitEntered: (n) =>
      entered.length >= n
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ n, resolve });
          }),
    release: () => release(),
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

const context = (
  traceId: string,
  name = "net_tool",
  effect: ToolEffect = "network.read.public",
) => ({
  traceId,
  actor: "main_agent" as const,
  toolSet: new ToolSet([{ identity: { name, version: 1 }, actor: "main_agent", effect }]),
});

const signal = new AbortController().signal;

describe("runner network tool concurrency cap (focused revision)", () => {
  it("caps a network.read.public tool at 2 even with a none meter category", async () => {
    const gate = makeGate();
    const { registry, runner } = makeRunner({ networkToolConcurrency: 2 });
    registry.register(
      definition({ effect: "network.read.public", category: "none", concurrency: 3, execute: gate.executor }),
    );
    try {
      const first = runner.execute(
        { executionId: "n1", traceId: "t", tool: { name: "net_tool", version: 1 }, input: { text: "alpha" } },
        context("t"),
        signal,
        () => {},
      );
      const second = runner.execute(
        { executionId: "n2", traceId: "t", tool: { name: "net_tool", version: 1 }, input: { text: "bravo" } },
        context("t"),
        signal,
        () => {},
      );
      await gate.waitEntered(2);
      expect(gate.enteredCount()).toBe(2);
      const third = runner.execute(
        { executionId: "n3", traceId: "t", tool: { name: "net_tool", version: 1 }, input: { text: "charlie" } },
        context("t"),
        signal,
        () => {},
      );
      // The third must be rejected, never reach the executor.
      const outcome = (await Promise.race([
        third.then((result) => ({ rejected: true as const, result })),
        gate.waitEntered(3).then(() => ({ rejected: false as const })),
      ])) as { rejected: true; result: ToolExecutionResult } | { rejected: false };
      expect(outcome.rejected).toBe(true);
      if (outcome.rejected) {
        expect(outcome.result.status).toBe("failed");
        if (outcome.result.status === "failed") {
          expect(outcome.result.failure.code).toBe("budget_exceeded");
          expect(outcome.result.failure.message).not.toContain("alpha");
          expect(outcome.result.failure.message).not.toContain("bravo");
          expect(outcome.result.failure.message).not.toContain("charlie");
        }
      }
      gate.release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.status).toBe("completed");
      expect(secondResult.status).toBe("completed");
    } finally {
      gate.release();
    }
  });

  it("does not cap a project.read tool even with a parse meter category", async () => {
    const gate = makeGate();
    const { registry, runner } = makeRunner({ networkToolConcurrency: 2 });
    registry.register(
      definition({ effect: "project.read", category: "parse", concurrency: 3, execute: gate.executor }),
    );
    try {
      const executions = [1, 2, 3].map((index) =>
        runner.execute(
          {
            executionId: `l${index}`,
            traceId: "t",
            tool: { name: "net_tool", version: 1 },
            input: { text: `t${index}` },
          },
          context("t", "net_tool", "project.read"),
          signal,
          () => {},
        ),
      );
      // All three must enter the executor concurrently; if the third is
      // wrongly rejected, the race reports it instead of hanging.
      const outcome = await Promise.race([
        gate.waitEntered(3).then(() => "entered" as const),
        executions[2]!.then((result) =>
          result.status === "failed" ? ("rejected" as const) : ("entered" as const),
        ),
      ]);
      expect(outcome).toBe("entered");
      gate.release();
      const results = await Promise.all(executions);
      expect(results.every((result) => result.status === "completed")).toBe(true);
    } finally {
      gate.release();
    }
  });

  it("releases the network slot after failures so later executions start again", async () => {
    const { registry, runner } = makeRunner({ networkToolConcurrency: 2 });
    registry.register(
      definition({
        effect: "network.read.public",
        category: "search",
        concurrency: 2,
        execute: async () => {
          throw new Error("executor boom");
        },
      }),
    );
    const startedEvents: string[] = [];
    const run = (executionId: string, text: string) =>
      runner.execute(
        { executionId, traceId: "t", tool: { name: "net_tool", version: 1 }, input: { text } },
        context("t"),
        signal,
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
    expect(startedEvents).toContain("f1");
    expect(startedEvents).toContain("f2");
  });

  it("keeps the global concurrency cap across traces with executors in flight", async () => {
    const gate = makeGate();
    const { registry, runner } = makeRunner({ networkToolConcurrency: 2, globalConcurrency: 4 });
    registry.register(
      definition({ effect: "project.read", category: "none", concurrency: 4, execute: gate.executor }),
    );
    try {
      const executions = [1, 2, 3, 4, 5].map((index) =>
        runner.execute(
          {
            executionId: `g${index}`,
            traceId: `trace-${index}`,
            tool: { name: "net_tool", version: 1 },
            input: { text: `t${index}` },
          },
          context(`trace-${index}`, "net_tool", "project.read"),
          signal,
          () => {},
        ),
      );
      await gate.waitEntered(4);
      expect(gate.enteredCount()).toBe(4);
      const fifth = await executions[4]!;
      expect(fifth.status).toBe("failed");
      if (fifth.status === "failed") {
        expect(fifth.failure.code).toBe("budget_exceeded");
      }
      gate.release();
      const settled = await Promise.all(executions.slice(0, 4));
      expect(settled.every((result) => result.status === "completed")).toBe(true);
      expect(gate.enteredCount()).toBe(4);
    } finally {
      gate.release();
    }
  });
});
