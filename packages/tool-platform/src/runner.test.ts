import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ToolExecutionEventSchema, ToolExecutionResultSchema } from "@deepfield/contracts";
import type { ToolCallRequest, ToolExecutionEvent } from "@deepfield/contracts";
import { ToolBudgetLedger } from "./budget.js";
import type { ToolDefinition, ToolRunContext } from "./definition.js";
import { ToolPolicy } from "./policy.js";
import { ToolRegistry } from "./registry.js";
import { ToolRunner } from "./runner.js";
import { ToolSet, type ToolGrant } from "./tool-set.js";
import { FakeAuditSink, FakeRetryClock } from "./testing.js";

const echoInput = Type.Object({ text: Type.String() }, { additionalProperties: false });
const echoOutput = Type.Object({ text: Type.String() }, { additionalProperties: false });

function echoDefinition(
  overrides: Partial<ToolDefinition<typeof echoInput, typeof echoOutput>> = {},
): ToolDefinition<typeof echoInput, typeof echoOutput> {
  return {
    identity: { name: "echo", version: 1 },
    label: "Echo",
    description: "Test echo tool",
    inputSchema: echoInput,
    outputSchema: echoOutput,
    effect: "network.read.public",
    timeoutMs: 10_000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 1,
    meter: { category: "none", countsBytes: false, countsTime: true },
    execute: async ({ text }) => ({ text }),
    ...overrides,
  };
}

const echoGrant: ToolGrant = {
  identity: { name: "echo", version: 1 },
  actor: "developer_probe",
  effect: "network.read.public",
};

interface SetupOptions {
  definition?: ToolDefinition<typeof echoInput, typeof echoOutput>;
  grant?: ToolGrant | null;
  maxCalls?: number;
  audit?: FakeAuditSink;
}

function setup(options: SetupOptions = {}) {
  const clock = new FakeRetryClock();
  const registry = new ToolRegistry();
  registry.register(options.definition ?? echoDefinition());
  const toolSet = new ToolSet(options.grant === null ? [] : [options.grant ?? echoGrant]);
  const context: ToolRunContext = { traceId: "trace-1", actor: "developer_probe", toolSet };
  const budget = new ToolBudgetLedger({ maxCalls: options.maxCalls ?? 100 }, () => clock.now());
  const audit = options.audit ?? new FakeAuditSink();
  const runner = new ToolRunner({ registry, policy: new ToolPolicy(), budget, audit, clock });
  const signal = new AbortController().signal;
  const events: ToolExecutionEvent[] = [];
  const call: ToolCallRequest = {
    executionId: "exec-1",
    traceId: "trace-1",
    tool: { name: "echo", version: 1 },
    input: { text: "hi" },
  };
  return { runner, call, context, signal, events, audit, budget, clock, registry };
}

const isTerminal = (event: ToolExecutionEvent): boolean =>
  event.type === "completed" || event.type === "failed" || event.type === "cancelled";

describe("ToolRunner happy path", () => {
  it("runs the pipeline in order with validated input and schema-checked output", async () => {
    let seenInput: unknown;
    let executorCalls = 0;
    const { runner, call, context, signal, events } = setup({
      definition: echoDefinition({
        execute: async (input) => {
          seenInput = input;
          executorCalls += 1;
          return input;
        },
      }),
    });
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result).toMatchObject({ status: "completed", executionId: "exec-1" });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({ text: "hi" });
    }
    expect(seenInput).toEqual({ text: "hi" });
    expect(executorCalls).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "accepted",
      "validated",
      "policy_checked",
      "started",
      "completed",
    ]);
    expect(signal.aborted).toBe(false);
  });

  it("emits correlated events with monotonic sequence starting at 0 and contract-valid schemas", async () => {
    const { runner, call, context, signal, events } = setup();
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    for (const event of events) {
      expect(event.executionId).toBe("exec-1");
      expect(event.traceId).toBe("trace-1");
      expect(event.tool).toEqual({ name: "echo", version: 1 });
      expect(Value.Check(ToolExecutionEventSchema, event)).toBe(true);
    }
    expect(Value.Check(ToolExecutionResultSchema, result)).toBe(true);
  });

  it("finalizes audit and budget before emitting completed", async () => {
    const audit = new FakeAuditSink({ deferFinish: true });
    const { runner, call, context, signal, events, budget } = setup({ audit });
    let startedSeenResolve!: () => void;
    const startedSeen = new Promise<void>((resolve) => {
      startedSeenResolve = resolve;
    });
    const pending = runner.execute(call, context, signal, (event) => {
      events.push(event);
      if (event.type === "started") {
        startedSeenResolve();
      }
    });
    await startedSeen;
    expect(events.map((event) => event.type)).not.toContain("completed");
    audit.releaseFinish();
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(events.map((event) => event.type)).toContain("completed");
    expect(audit.records.map((record) => record.kind)).toEqual(["start", "finish"]);
    expect(budget.reserve({ name: "echo", version: 1 }, "none")).toBeDefined();
  });
});

describe("ToolRunner failure paths never execute unauthorized tools", () => {
  it("releases a reservation when audit start rejects before dispatch", async () => {
    const audit = new FakeAuditSink({ failStart: true });
    const { runner, call, context, signal, budget } = setup({ maxCalls: 1, audit });

    const result = await runner.execute(call, context, signal, () => {});

    expect(result.status).toBe("failed");
    expect(budget.snapshot().total).toEqual({
      limit: 1,
      reserved: 0,
      consumed: 0,
      remaining: 1,
      exhausted: false,
    });
  });

  it("releases a reservation when cancellation wins before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const { runner, call, context, budget } = setup({ maxCalls: 1 });

    const result = await runner.execute(call, context, controller.signal, () => {});

    expect(result.status).toBe("cancelled");
    expect(budget.snapshot().total).toEqual({
      limit: 1,
      reserved: 0,
      consumed: 0,
      remaining: 1,
      exhausted: false,
    });
  });

  it("keeps quota consumed when executor dispatch fails", async () => {
    const { runner, call, context, signal, budget } = setup({
      maxCalls: 1,
      definition: echoDefinition({
        execute: async () => {
          throw new Error("external failure");
        },
      }),
    });

    const result = await runner.execute(call, context, signal, () => {});

    expect(result.status).toBe("failed");
    expect(budget.snapshot().total).toEqual({
      limit: 1,
      reserved: 0,
      consumed: 1,
      remaining: 0,
      exhausted: true,
    });
  });

  it("rejects invalid input with a single terminal and zero executor calls", async () => {
    let executorCalls = 0;
    const { runner, call, context, signal, events } = setup({
      definition: echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: "x" };
        },
      }),
    });
    const result = await runner.execute(
      { ...call, input: { text: 42 } },
      context,
      signal,
      (event) => events.push(event),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("invalid_input");
    }
    expect(executorCalls).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["accepted", "failed"]);
    expect(events.filter(isTerminal)).toHaveLength(1);
  });

  it("fails with tool_not_found for unknown versions", async () => {
    let executorCalls = 0;
    const { runner, context, signal, events } = setup({
      definition: echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: "x" };
        },
      }),
    });
    const result = await runner.execute(
      {
        executionId: "exec-1",
        traceId: "trace-1",
        tool: { name: "echo", version: 2 },
        input: { text: "hi" },
      },
      context,
      signal,
      (event) => events.push(event),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("tool_not_found");
    }
    expect(executorCalls).toBe(0);
    expect(events.filter(isTerminal)).toHaveLength(1);
  });

  it("denies without a grant and never calls the executor", async () => {
    let executorCalls = 0;
    const { runner, call, context, signal, events } = setup({
      grant: null,
      definition: echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: "x" };
        },
      }),
    });
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("tool_not_allowed");
    }
    expect(executorCalls).toBe(0);
    expect(events.filter(isTerminal)).toHaveLength(1);
  });

  it("denies actor mismatches with permission_denied", async () => {
    let executorCalls = 0;
    const { runner, call, signal, events } = setup({
      definition: echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: "x" };
        },
      }),
    });
    const context: ToolRunContext = {
      traceId: "trace-1",
      actor: "main_agent",
      toolSet: new ToolSet([echoGrant]),
    };
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("permission_denied");
    }
    expect(executorCalls).toBe(0);
  });

  it("fails with budget_exceeded before starting the executor", async () => {
    let executorCalls = 0;
    const { runner, call, context, signal, events } = setup({
      maxCalls: 0,
      definition: echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: "x" };
        },
      }),
    });
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("budget_exceeded");
    }
    expect(executorCalls).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "accepted",
      "validated",
      "policy_checked",
      "failed",
    ]);
    expect(events.filter(isTerminal)).toHaveLength(1);
  });

  it("rejects invalid executor output without reporting success", async () => {
    let executorCalls = 0;
    const { runner, call, context, signal, events, budget } = setup({
      definition: echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: 42 } as unknown as { text: string };
        },
      }),
    });
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("invalid_output");
    }
    expect(executorCalls).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "accepted",
      "validated",
      "policy_checked",
      "started",
      "failed",
    ]);
    expect(events.filter(isTerminal)).toHaveLength(1);
    expect(budget.reserve({ name: "echo", version: 1 }, "none")).toBeDefined();
  });
});
