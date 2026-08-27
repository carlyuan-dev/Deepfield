import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolCallRequest, ToolExecutionEvent } from "@deepfield/contracts";
import type { ToolDefinition, ToolRunContext } from "./definition.js";
import { ToolBudgetLedger } from "./budget.js";
import { ToolExecutionError } from "./errors.js";
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

describe("ToolRunner retry", () => {
  it("retries a rate_limited failure and succeeds on the second attempt", async () => {
    let executorCalls = 0;
    let retrySeenResolve!: () => void;
    const retrySeen = new Promise<void>((resolve) => {
      retrySeenResolve = resolve;
    });
    const { runner, call, context, signal, events, clock, audit } = setup(
      echoDefinition({
        retry: { maxRetries: 1, backoffMs: 100 },
        execute: async () => {
          executorCalls += 1;
          if (executorCalls === 1) {
            throw new ToolExecutionError("rate_limited", { httpStatus: 429 });
          }
          return { text: "ok" };
        },
      }),
    );
    const pending = runner.execute(call, context, signal, (event) => {
      events.push(event);
      if (event.type === "retry_scheduled") {
        retrySeenResolve();
      }
    });
    await retrySeen;
    clock.advance(100);
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(executorCalls).toBe(2);
    expect(events.map((event) => event.type)).toEqual(["accepted", "validated", "policy_checked", "started", "retry_scheduled", "started", "completed"]);
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    const finish = audit.records.find((record) => record.kind === "finish");
    expect(finish?.record.attempts).toBe(2);
  });

  it("retries a controlled 5xx executor failure", async () => {
    let executorCalls = 0;
    let retrySeenResolve!: () => void;
    const retrySeen = new Promise<void>((resolve) => {
      retrySeenResolve = resolve;
    });
    const { runner, call, context, signal, events, clock } = setup(
      echoDefinition({
        retry: { maxRetries: 1, backoffMs: 50 },
        execute: async () => {
          executorCalls += 1;
          if (executorCalls === 1) {
            throw new ToolExecutionError("executor_failed", { httpStatus: 502 });
          }
          return { text: "ok" };
        },
      }),
    );
    const pending = runner.execute(call, context, signal, (event) => {
      events.push(event);
      if (event.type === "retry_scheduled") {
        retrySeenResolve();
      }
    });
    await retrySeen;
    clock.advance(50);
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(executorCalls).toBe(2);
  });

  it("does not retry authentication failures", async () => {
    let executorCalls = 0;
    const { runner, call, context, signal, events } = setup(
      echoDefinition({
        retry: { maxRetries: 2, backoffMs: 10 },
        execute: async () => {
          executorCalls += 1;
          throw new ToolExecutionError("authentication_failed", { httpStatus: 401 });
        },
      }),
    );
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("authentication_failed");
    }
    expect(executorCalls).toBe(1);
    expect(events.filter((event) => event.type === "retry_scheduled")).toHaveLength(0);
  });

  it("maps raw executor exceptions to a fixed executor_failed failure without retry", async () => {
    let executorCalls = 0;
    const { runner, call, context, signal, events } = setup(
      echoDefinition({
        retry: { maxRetries: 2, backoffMs: 10 },
        execute: async () => {
          executorCalls += 1;
          throw new Error("boom");
        },
      }),
    );
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("executor_failed");
      expect(result.failure.retryable).toBe(false);
      expect(result.failure.attempts).toBe(1);
    }
    expect(executorCalls).toBe(1);
    expect(events.filter((event) => event.type === "retry_scheduled")).toHaveLength(0);
    expect(events.filter(isTerminal)).toHaveLength(1);
  });

  it("aborting during backoff cancels immediately without starting the next attempt", async () => {
    let executorCalls = 0;
    let retrySeenResolve!: () => void;
    const retrySeen = new Promise<void>((resolve) => {
      retrySeenResolve = resolve;
    });
    const controller = new AbortController();
    const { runner, call, context, events } = setup(
      echoDefinition({
        retry: { maxRetries: 2, backoffMs: 100 },
        execute: async () => {
          executorCalls += 1;
          throw new ToolExecutionError("rate_limited", { httpStatus: 429 });
        },
      }),
    );
    const pending = runner.execute(call, context, controller.signal, (event) => {
      events.push(event);
      if (event.type === "retry_scheduled") {
        retrySeenResolve();
      }
    });
    await retrySeen;
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(executorCalls).toBe(1);
    expect(events.filter(isTerminal)).toHaveLength(1);
  });

  it("retries at most twice after the initial attempt", async () => {
    let executorCalls = 0;
    let retries = 0;
    let firstResolve!: () => void;
    let secondResolve!: () => void;
    const first = new Promise<void>((resolve) => {
      firstResolve = resolve;
    });
    const second = new Promise<void>((resolve) => {
      secondResolve = resolve;
    });
    const { runner, call, context, signal, events, clock } = setup(
      echoDefinition({
        retry: { maxRetries: 2, backoffMs: 50 },
        execute: async () => {
          executorCalls += 1;
          throw new ToolExecutionError("rate_limited", { httpStatus: 429 });
        },
      }),
    );
    const pending = runner.execute(call, context, signal, (event) => {
      events.push(event);
      if (event.type === "retry_scheduled") {
        retries += 1;
        if (retries === 1) {
          firstResolve();
        } else {
          secondResolve();
        }
      }
    });
    await first;
    clock.advance(50);
    await second;
    clock.advance(50);
    const result = await pending;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("rate_limited");
      expect(result.failure.attempts).toBe(3);
    }
    expect(executorCalls).toBe(3);
    expect(retries).toBe(2);
    expect(events.filter(isTerminal)).toHaveLength(1);
  });

  it("caps backoff at the remaining deadline so the total timeout always holds", async () => {
    let executorCalls = 0;
    let retrySeenResolve!: (event: ToolExecutionEvent) => void;
    const retrySeen = new Promise<ToolExecutionEvent>((resolve) => {
      retrySeenResolve = resolve;
    });
    const { runner, call, context, signal, events, clock } = setup(
      echoDefinition({
        timeoutMs: 100,
        retry: { maxRetries: 1, backoffMs: 1000 },
        execute: async () => {
          executorCalls += 1;
          throw new ToolExecutionError("rate_limited", { httpStatus: 429 });
        },
      }),
    );
    const pending = runner.execute(call, context, signal, (event) => {
      events.push(event);
      if (event.type === "retry_scheduled") {
        retrySeenResolve(event);
      }
    });
    const retryEvent = await retrySeen;
    expect(retryEvent.type).toBe("retry_scheduled");
    if (retryEvent.type === "retry_scheduled") {
      expect(retryEvent.retryDelayMs).toBe(100);
    }
    clock.advance(100);
    const result = await pending;
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("timeout");
      // attempts reflect the actual executor invocation count, not the loop
      // counter: only one attempt ever ran before the deadline hit.
      expect(result.failure.attempts).toBe(1);
    }
    expect(executorCalls).toBe(1);
    expect(events.filter(isTerminal)).toHaveLength(1);
    expect(events.filter((event) => event.type === "started")).toHaveLength(1);
  });
});
