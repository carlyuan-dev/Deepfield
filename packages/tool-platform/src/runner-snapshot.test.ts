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
  return { runner, call, context, signal, events, audit, budget };
}

const isTerminal = (event: ToolExecutionEvent): boolean =>
  event.type === "completed" || event.type === "failed" || event.type === "cancelled";

describe("ToolRunner entry snapshots and immutability (focused revision)", () => {
  it("listener mutation of the accepted event tool cannot redirect resolution", async () => {
    const { runner, call, context, signal, events } = setup();
    const result = await runner.execute(call, context, signal, (event) => {
      events.push(event);
      if (event.type === "accepted") {
        try {
          (event.tool as { name: string }).name = "mutated";
        } catch {
          // frozen: assignment throws and is isolated
        }
      }
    });
    expect(result.status).toBe("completed");
    expect(Object.isFrozen(events[0]!.tool)).toBe(true);
    expect(events[0]!.tool.name).toBe("echo");
    expect(events[0]!.tool).not.toBe(call.tool);
  });

  it("listener mutation of progress and failure payloads cannot corrupt events", async () => {
    let onProgressFn: ((progress: ToolProgress) => void) | undefined;
    const { runner, call, context, signal, events } = setup(
      echoDefinition({
        execute: async (_input, _context, _signal, onProgress) => {
          onProgressFn = onProgress;
          onProgress?.({ kind: "fetching", bytes: 4 });
          return { text: "x" };
        },
      }),
    );
    await runner.execute(call, context, signal, (event) => {
      events.push(event);
      if (event.type === "progress") {
        try {
          (event.progress as Record<string, unknown>)["secret"] = "injected";
        } catch {
          // frozen
        }
      }
    });
    const progressEvent = events.find((event) => event.type === "progress");
    expect(progressEvent).toBeDefined();
    if (progressEvent && progressEvent.type === "progress") {
      expect(Object.isFrozen(progressEvent.progress)).toBe(true);
      expect(JSON.stringify(progressEvent.progress)).not.toContain("injected");
    }
  });

  it("executor receives an immutable input snapshot, not the caller's mutable object", async () => {
    let received: unknown;
    let executorCalledResolve!: () => void;
    const executorCalled = new Promise<void>((resolve) => {
      executorCalledResolve = resolve;
    });
    const audit = new FakeAuditSink({ deferStart: true });
    const { runner, call, context, signal } = setup(
      echoDefinition({
        execute: async (input) => {
          received = input;
          executorCalledResolve();
          return { text: "ok" };
        },
      }),
      audit,
    );
    const pending = runner.execute(call, context, signal, () => {});
    await audit.startSeen();
    (call.input as { text: string }).text = "mutated";
    audit.releaseStart();
    const result = await pending;
    await executorCalled;
    expect(result.status).toBe("completed");
    expect(received).toEqual({ text: "hi" });
    expect(Object.isFrozen(received)).toBe(true);
  });

  it("rejects a context traceId that does not match the call traceId", async () => {
    let executorCalls = 0;
    const { runner, call, signal, events } = setup(
      echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: "x" };
        },
      }),
    );
    const context: ToolRunContext = {
      traceId: "other-trace",
      actor: "developer_probe",
      toolSet: new ToolSet([echoGrant]),
    };
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("invalid_input");
    }
    expect(executorCalls).toBe(0);
    expect(events.filter(isTerminal)).toHaveLength(1);
  });

  it("executor context is a frozen scope without ToolSet or confirmations", async () => {
    let seenContext: ToolRunContext | undefined;
    let executorCalledResolve!: () => void;
    const executorCalled = new Promise<void>((resolve) => {
      executorCalledResolve = resolve;
    });
    const { runner, call, context, signal } = setup(
      echoDefinition({
        execute: async (_input, ctx) => {
          seenContext = ctx;
          executorCalledResolve();
          return { text: "x" };
        },
      }),
    );
    await runner.execute(call, context, signal, () => {});
    await executorCalled;
    expect(Object.isFrozen(seenContext)).toBe(true);
    expect(seenContext!.toolSet).toBeUndefined();
    expect(seenContext!.confirmations).toBeUndefined();
    expect(seenContext!.traceId).toBe("trace-1");
    expect(seenContext!.actor).toBe("developer_probe");
  });

  it("classifies synchronous executor throws as executor_failed with full cleanup", async () => {
    let called = false;
    const { runner, call, context, signal, events, budget } = setup(
      echoDefinition({
        execute: (() => {
          called = true;
          throw new Error("boom");
        }) as unknown as ToolDefinition<typeof echoInput, typeof echoOutput>["execute"],
      }),
    );
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("executor_failed");
      expect(result.failure.message).not.toContain("boom");
    }
    expect(called).toBe(true);
    expect(events.filter(isTerminal)).toHaveLength(1);
    expect(budget.reserve({ name: "echo", version: 1 }, "none")).toBeDefined();
  });
});
