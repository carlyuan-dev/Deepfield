import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolCallRequest, ToolExecutionEvent } from "@deepfield/contracts";
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
  const budget = new ToolBudgetLedger({}, () => clock.now());
  const runner = new ToolRunner({ registry, policy: new ToolPolicy(), budget, audit, clock });
  const signal = new AbortController().signal;
  const call: ToolCallRequest = {
    executionId: "exec-1",
    traceId: "trace-1",
    tool: { name: "echo", version: 1 },
    input: { text: "hi" },
  };
  return { runner, call, context: undefined as never, signal };
}

describe("ToolRunner policy context snapshot (second revision)", () => {
  it("policy uses the entry context snapshot: listener actor mutation cannot grant access", async () => {
    let executorCalls = 0;
    const { runner, call, signal } = setup(
      echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: "x" };
        },
      }),
    );
    const context: ToolRunContext = {
      traceId: "trace-1",
      actor: "main_agent",
      toolSet: new ToolSet([echoGrant]),
    };
    const result = await runner.execute(call, context, signal, (event) => {
      if (event.type === "accepted") {
        (context as { actor: string }).actor = "developer_probe";
      }
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("permission_denied");
    }
    expect(executorCalls).toBe(0);
  });

  it("confirmations are snapshotted: listener add cannot grant and delete cannot revoke", async () => {
    const grantWithConfirmation: ToolGrant = {
      identity: { name: "echo", version: 1 },
      actor: "developer_probe",
      effect: "network.read.public",
      confirmationKind: "probe-ok",
    };
    const emptySet = new Set<string>();
    const revokedSet = new Set(["probe-ok"]);
    let executorCalls = 0;
    const { runner, call, signal } = setup(
      echoDefinition({
        execute: async () => {
          executorCalls += 1;
          return { text: "x" };
        },
      }),
    );
    const addResult = await runner.execute(
      call,
      {
        traceId: "trace-1",
        actor: "developer_probe",
        toolSet: new ToolSet([grantWithConfirmation]),
        confirmations: emptySet,
      },
      signal,
      (event) => {
        if (event.type === "accepted") {
          emptySet.add("probe-ok");
        }
      },
    );
    expect(addResult.status).toBe("failed");
    if (addResult.status === "failed") {
      expect(addResult.failure.code).toBe("confirmation_required");
    }
    expect(executorCalls).toBe(0);
    const revokedResult = await runner.execute(
      call,
      {
        traceId: "trace-1",
        actor: "developer_probe",
        toolSet: new ToolSet([grantWithConfirmation]),
        confirmations: revokedSet,
      },
      signal,
      (event) => {
        if (event.type === "accepted") {
          revokedSet.delete("probe-ok");
        }
      },
    );
    expect(revokedResult.status).toBe("completed");
    expect(executorCalls).toBe(1);
  });
});
