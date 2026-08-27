import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ToolExecutionEventSchema, ToolExecutionResultSchema } from "@deepfield/contracts";
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

describe("ToolRunner output snapshot (second revision)", () => {
  it("output is snapshotted before the audit gate: mutation during finish cannot leak", async () => {
    let returnedOutput: { text: string } | undefined;
    const audit = new FakeAuditSink({ deferFinish: true });
    const { runner, call, context, signal } = setup(
      echoDefinition({
        execute: async () => {
          returnedOutput = { text: "hi" };
          return returnedOutput;
        },
      }),
      audit,
    );
    const pending = runner.execute(call, context, signal, () => {});
    await audit.finishSeen();
    returnedOutput!.text = "sk-secret-value";
    audit.releaseFinish();
    const result = await pending;
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({ text: "hi" });
      expect(JSON.stringify(result)).not.toContain("sk-secret-value");
    }
  });

  it("completed output is an immutable snapshot; later executor mutation is invisible", async () => {
    const original = { text: "hi" };
    const { runner, call, context, signal } = setup(
      echoDefinition({
        execute: async () => original,
      }),
    );
    const result = await runner.execute(call, context, signal, () => {});
    original.text = "sk-secret-value";
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output).toEqual({ text: "hi" });
      expect(Object.isFrozen(result.output)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("sk-secret-value");
    }
  });

  it("non-JSON executor output maps to invalid_output with cleanup", async () => {
    const { runner, call, context, signal, events, budget } = setup(
      echoDefinition({
        execute: async () => {
          const output = new Date(0) as unknown as { text: string };
          output.text = "hi";
          return output;
        },
      }),
    );
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("invalid_output");
    }
    expect(events.filter(isTerminal)).toHaveLength(1);
    expect(budget.reserve({ name: "echo", version: 1 }, "none")).toBeDefined();
  });

  it("out-of-contract identity yields a contract-valid invalid_input result with safe placeholders", async () => {
    const { runner, context, signal } = setup();
    const badCall = {
      executionId: "",
      traceId: "",
      tool: { name: "", version: 0 },
    } as unknown as ToolCallRequest;
    const result = await runner.execute(badCall, context, signal, () => {});
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("invalid_input");
    }
    expect(Value.Check(ToolExecutionResultSchema, result)).toBe(true);
    expect(result.executionId.length).toBeGreaterThan(0);
    expect(result.traceId.length).toBeGreaterThan(0);
  });
});

describe("ToolRunner correlation validation (third revision)", () => {
  const scenarios: { name: string; executionId?: unknown; traceId?: unknown }[] = [
    { name: "empty executionId", executionId: "" },
    { name: "non-string executionId", executionId: 123 },
    { name: "empty traceId", traceId: "" },
    { name: "non-string traceId", traceId: null },
  ];

  for (const scenario of scenarios) {
    it(`rejects ${scenario.name} with a contract-valid invalid_input and no events`, async () => {
      let executorCalls = 0;
      const { runner, context, signal, events } = setup(
        echoDefinition({
          execute: async () => {
            executorCalls += 1;
            return { text: "x" };
          },
        }),
      );
      const call = {
        executionId: scenario.executionId !== undefined ? scenario.executionId : "exec-1",
        traceId: scenario.traceId !== undefined ? scenario.traceId : "trace-1",
        tool: { name: "echo", version: 1 },
        input: { text: "hi" },
      } as unknown as ToolCallRequest;
      const result = await runner.execute(call, context, signal, (event) => events.push(event));
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.failure.code).toBe("invalid_input");
      }
      expect(Value.Check(ToolExecutionResultSchema, result)).toBe(true);
      expect(result.executionId.length).toBeGreaterThan(0);
      expect(result.traceId.length).toBeGreaterThan(0);
      expect(events).toHaveLength(0);
      expect(executorCalls).toBe(0);
    });
  }

  it("keeps legal correlation event sequences unchanged and contract-valid", async () => {
    const { runner, call, context, signal, events } = setup();
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("completed");
    expect(events.map((event) => event.type)).toEqual([
      "accepted",
      "validated",
      "policy_checked",
      "started",
      "completed",
    ]);
    for (const event of events) {
      expect(Value.Check(ToolExecutionEventSchema, event)).toBe(true);
    }
  });
});
