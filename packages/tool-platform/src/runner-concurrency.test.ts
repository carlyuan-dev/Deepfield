import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolCallRequest, ToolExecutionEvent, ToolExecutionResult } from "@deepfield/contracts";
import type { ToolDefinition, ToolRunContext } from "./definition.js";
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

function startedMarker(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function expectSlotReusable(
  runner: ToolRunner,
  call: ToolCallRequest,
  context: ToolRunContext,
  runSignal: AbortSignal,
  successSignal: AbortSignal,
  runFirst: () => Promise<ToolExecutionResult>,
): Promise<void> {
  const first = await runFirst();
  expect(first.status).not.toBe("completed");
  const second = await runner.execute(call, context, successSignal, () => {});
  expect(second.status).toBe("completed");
}describe("ToolRunner definition concurrency (third revision)", () => {
  it("blocks a second concurrent call for the same tool when definition.concurrency is 1", async () => {
    let executorCalls = 0;
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    let firstCall = true;
    const marker = startedMarker();
    const { runner, call, context, signal } = setup(
      echoDefinition({
        concurrency: 1,
        execute: async () => {
          executorCalls += 1;
          if (firstCall) {
            firstCall = false;
            active += 1;
            maxActive = Math.max(maxActive, active);
            marker.resolve();
            await new Promise<void>((resolve) => (releaseFirst = resolve));
            active -= 1;
          }
          return { text: "x" };
        },
      }),
    );
    const first = runner.execute(call, context, signal, () => {});
    await marker.promise;
    const second = await runner.execute(call, context, signal, () => {});
    expect(second.status).toBe("failed");
    if (second.status === "failed") {
      expect(second.failure.code).toBe("budget_exceeded");
    }
    expect(executorCalls).toBe(1);
    expect(maxActive).toBe(1);
    releaseFirst();
    const firstResult = await first;
    expect(firstResult.status).toBe("completed");
    const third = await runner.execute(call, context, signal, () => {});
    expect(third.status).toBe("completed");
    expect(executorCalls).toBe(2);
  });
  it("isolates concurrency limits per name@version", async () => {
    let executorCalls = 0;
    let releaseFirst!: () => void;
    const marker = startedMarker();
    const definitionV1 = echoDefinition({
      identity: { name: "echo", version: 1 },
      concurrency: 1,
      execute: async () => {
        executorCalls += 1;
        marker.resolve();
        await new Promise<void>((resolve) => (releaseFirst = resolve));
        return { text: "x" };
      },
    });
    const definitionV2 = echoDefinition({
      identity: { name: "echo", version: 2 },
      concurrency: 1,
      execute: async () => {
        executorCalls += 1;
        return { text: "y" };
      },
    });
    const grantV2: ToolGrant = {
      identity: { name: "echo", version: 2 },
      actor: "developer_probe",
      effect: "network.read.public",
    };
    const clock = new FakeRetryClock();
    const registry = new ToolRegistry();
    registry.register(definitionV1);
    registry.register(definitionV2);
    const budget = new ToolBudgetLedger({}, () => clock.now());
    const runner = new ToolRunner({
      registry,
      policy: new ToolPolicy(),
      budget,
      audit: new FakeAuditSink(),
      clock,
    });
    const context: ToolRunContext = {
      traceId: "trace-1",
      actor: "developer_probe",
      toolSet: new ToolSet([echoGrant, grantV2]),
    };
    const signal = new AbortController().signal;
    const callV1: ToolCallRequest = {
      executionId: "exec-1",
      traceId: "trace-1",
      tool: { name: "echo", version: 1 },
      input: { text: "hi" },
    };
    const callV2: ToolCallRequest = {
      executionId: "exec-2",
      traceId: "trace-1",
      tool: { name: "echo", version: 2 },
      input: { text: "hi" },
    };
    const first = runner.execute(callV1, context, signal, () => {});    await marker.promise;
    const second = await runner.execute(callV2, context, signal, () => {});
    expect(second.status).toBe("completed");
    expect(executorCalls).toBe(2);
    releaseFirst();
    await first;
  });
  it("releases the concurrency slot after executor failure", async () => {
    let firstCall = true;
    const { runner, call, context, signal } = setup(
      echoDefinition({
        concurrency: 1,
        execute: async () => {
          if (firstCall) {
            firstCall = false;
            throw new Error("boom");
          }
          return { text: "x" };
        },
      }),
    );
    await expectSlotReusable(runner, call, context, signal, signal, () =>
      runner.execute(call, context, signal, () => {}),
    );
  });
  it("releases the concurrency slot after invalid output", async () => {
    let firstCall = true;
    const { runner, call, context, signal } = setup(
      echoDefinition({
        concurrency: 1,
        execute: async () => {
          if (firstCall) {
            firstCall = false;
            return { text: 42 } as unknown as { text: string };
          }
          return { text: "x" };
        },
      }),
    );
    await expectSlotReusable(runner, call, context, signal, signal, () =>
      runner.execute(call, context, signal, () => {}),
    );
  });
  it("releases the concurrency slot after audit finish failure", async () => {
    const audit = new FakeAuditSink({ failFinishOnce: true });
    const { runner, call, context, signal } = setup(echoDefinition({ concurrency: 1 }), audit);
    await expectSlotReusable(runner, call, context, signal, signal, () =>
      runner.execute(call, context, signal, () => {}),
    );
  });
  it("releases the concurrency slot after timeout", async () => {
    let firstRun = true;
    const marker = startedMarker();
    const { runner, call, context, signal, clock } = setup(
      echoDefinition({
        concurrency: 1,
        timeoutMs: 100,
        execute: async () => {
          if (firstRun) {
            firstRun = false;
            marker.resolve();
            await new Promise(() => {});
            return { text: "x" };
          }
          return { text: "x" };
        },
      }),
    );
    await expectSlotReusable(runner, call, context, signal, signal, async () => {      const pending = runner.execute(call, context, signal, () => {});
      await marker.promise;
      clock.advance(100);
      return pending;
    });
  });
  it("releases the concurrency slot after cancellation", async () => {
    const controller = new AbortController();
    const marker = startedMarker();
    let firstCall = true;
    const { runner, call, context } = setup(
      echoDefinition({
        concurrency: 1,
        execute: async () => {
          if (firstCall) {
            firstCall = false;
            marker.resolve();
            await new Promise(() => {});
            return { text: "x" };
          }
          return { text: "x" };
        },
      }),
    );
    const successSignal = new AbortController().signal;
    await expectSlotReusable(runner, call, context, controller.signal, successSignal, async () => {
      const pending = runner.execute(call, context, controller.signal, () => {});
      await marker.promise;
      controller.abort();
      return pending;
    });
  });
  it("releases the concurrency slot after a synchronous throw", async () => {
    let firstCall = true;
    const { runner, call, context, signal } = setup(
      echoDefinition({
        concurrency: 1,
        execute: (() => {
          if (firstCall) {
            firstCall = false;
            throw new Error("boom");
          }
          return { text: "x" };
        }) as unknown as ToolDefinition<typeof echoInput, typeof echoOutput>["execute"],
      }),
    );
    await expectSlotReusable(runner, call, context, signal, signal, () =>
      runner.execute(call, context, signal, () => {}),
    );
  });
});
