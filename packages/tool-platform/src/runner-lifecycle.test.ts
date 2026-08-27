import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolCallRequest, ToolExecutionEvent } from "@deepfield/contracts";
import type { ToolDefinition, ToolProgress, ToolRunContext } from "./definition.js";
import { ToolBudgetLedger } from "./budget.js";
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

function setup(
  definition: ToolDefinition<typeof echoInput, typeof echoOutput> = echoDefinition(),
  audit: FakeAuditSink = new FakeAuditSink(),
) {
  const clock = new FakeRetryClock();
  const registry = new ToolRegistry();
  registry.register(definition);
  const context: ToolRunContext = {
    traceId: "trace-1",
    actor: "developer_probe",
    toolSet: new ToolSet([echoGrant]),
  };
  const budget = new ToolBudgetLedger({}, () => clock.now());
  const runner = new ToolRunner({ registry, policy: new ToolPolicy(), budget, audit, clock });
  const signal = new AbortController().signal;
  const events: ToolExecutionEvent[] = [];
  const call: ToolCallRequest = {
    executionId: "exec-1",
    traceId: "trace-1",
    tool: { name: "echo", version: 1 },
    input: { text: "hi" },
  };
  return { runner, call, context, signal, events, audit, budget, clock };
}

const isTerminal = (event: ToolExecutionEvent): boolean =>
  event.type === "completed" || event.type === "failed" || event.type === "cancelled";

function startedMarker(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ToolRunner lifecycle (focused revision)", () => {
  it("pre-aborted signals settle cancelled without starting the executor", async () => {
    let executorCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const { runner, call, context, audit, events } = setup(
      echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: "x" };
        },
      }),
    );
    const result = await runner.execute(call, context, controller.signal, (event) =>
      events.push(event),
    );
    expect(result.status).toBe("cancelled");
    expect(executorCalls).toBe(0);
    expect(events.map((event) => event.type)).toEqual([
      "accepted",
      "validated",
      "policy_checked",
      "cancelled",
    ]);
    expect(events.filter(isTerminal)).toHaveLength(1);
    const finish = audit.records.find((record) => record.kind === "finish");
    expect(finish?.record.status).toBe("cancelled");
  });

  it("mid-run abort cancels, aborts the executor signal and suppresses late results", async () => {
    let executorCalls = 0;
    let executorSignal: AbortSignal | undefined;
    let resolveExecutor!: () => void;
    const marker = startedMarker();
    const controller = new AbortController();
    const { runner, call, context, budget, events } = setup(
      echoDefinition({
        execute: async (_input, _context, signal) => {
          executorCalls += 1;
          executorSignal = signal;
          marker.resolve();
          await new Promise<void>((resolve) => {
            resolveExecutor = resolve;
          });
          return { text: "late" };
        },
      }),
    );
    const pending = runner.execute(call, context, controller.signal, (event) =>
      events.push(event),
    );
    await marker.promise;
    expect(executorSignal!.aborted).toBe(false);
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(executorSignal!.aborted).toBe(true);
    expect(executorCalls).toBe(1);
    resolveExecutor();
    expect(events.filter(isTerminal)).toHaveLength(1);
    expect(budget.reserve({ name: "echo", version: 1 }, "none")).toBeDefined();
  });

  it("times out after the definition timeout and aborts the executor", async () => {
    let executorSignal: AbortSignal | undefined;
    const marker = startedMarker();
    const { runner, call, context, signal, events, clock } = setup(
      echoDefinition({
        timeoutMs: 1000,
        execute: async (_input, _context, executorSignalParam) => {
          executorSignal = executorSignalParam;
          marker.resolve();
          await new Promise(() => {});
          return { text: "unreachable" };
        },
      }),
    );
    const pending = runner.execute(call, context, signal, (event) => events.push(event));
    await marker.promise;
    clock.advance(1000);
    const result = await pending;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("timeout");
      expect(result.failure.retryable).toBe(false);
    }
    expect(executorSignal!.aborted).toBe(true);
    expect(events.filter(isTerminal)).toHaveLength(1);
  });

  it("settles exactly once when completion and timeout race", async () => {
    let resolveExecutor!: () => void;
    const marker = startedMarker();
    const { runner, call, context, signal, events, clock } = setup(
      echoDefinition({
        timeoutMs: 1000,
        execute: async () => {
          marker.resolve();
          await new Promise<void>((resolve) => {
            resolveExecutor = resolve;
          });
          return { text: "x" };
        },
      }),
    );
    const pending = runner.execute(call, context, signal, (event) => events.push(event));
    await marker.promise;
    clock.advance(1000);
    resolveExecutor();
    const result = await pending;
    expect(events.filter(isTerminal)).toHaveLength(1);
    if (result.status === "completed") {
      expect(result.output).toEqual({ text: "x" });
    } else if (result.status === "failed") {
      expect(result.failure.code).toBe("timeout");
    }
  });

  it("fails with audit_failed when audit start rejects", async () => {
    let executorCalls = 0;
    const audit = new FakeAuditSink({ failStart: true });
    const { runner, call, context, signal, events, budget } = setup(
      echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: "x" };
        },
      }),
      audit,
    );
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("audit_failed");
    }
    expect(executorCalls).toBe(0);
    expect(events.filter(isTerminal)).toHaveLength(1);
    expect(budget.reserve({ name: "echo", version: 1 }, "none")).toBeDefined();
  });

  it("never reports completed when required audit finish fails", async () => {
    const audit = new FakeAuditSink({ failFinish: true });
    const { runner, call, context, signal, events, budget } = setup(echoDefinition(), audit);
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("audit_failed");
    }
    expect(events.map((event) => event.type)).not.toContain("completed");
    expect(events.filter(isTerminal)).toHaveLength(1);
    expect(budget.reserve({ name: "echo", version: 1 }, "none")).toBeDefined();
  });

  it("isolates onEvent failures without double-terminal or raw error leaks", async () => {
    let throwsLeft = 1;
    const { runner, call, context, signal, events } = setup();
    const result = await runner.execute(call, context, signal, (event) => {
      if (event.type === "started" && throwsLeft > 0) {
        throwsLeft -= 1;
        throw new Error("listener boom");
      }
      events.push(event);
    });
    expect(result.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual([
      "accepted",
      "validated",
      "policy_checked",
      "completed",
    ]);
    expect(events.filter(isTerminal)).toHaveLength(1);
    const serialized = JSON.stringify({ result, events });
    expect(serialized).not.toContain("listener boom");
  });

  it("suppresses progress and results after the terminal event", async () => {
    let onProgressFn: ((progress: ToolProgress) => void) | undefined;
    let resolveExecutor!: () => void;
    const marker = startedMarker();
    const controller = new AbortController();
    const { runner, call, context, events } = setup(
      echoDefinition({
        execute: async (_input, _context, _signal, onProgress) => {
          onProgressFn = onProgress;
          marker.resolve();
          await new Promise<void>((resolve) => {
            resolveExecutor = resolve;
          });
          return { text: "x" };
        },
      }),
    );
    const pending = runner.execute(call, context, controller.signal, (event) =>
      events.push(event),
    );
    await marker.promise;
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    onProgressFn?.({ kind: "fetching", bytes: 5 });
    resolveExecutor();
    expect(events.filter((event) => event.type === "progress")).toHaveLength(0);
    expect(events.filter(isTerminal)).toHaveLength(1);
  });
});
