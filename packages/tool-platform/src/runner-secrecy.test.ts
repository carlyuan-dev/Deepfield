import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolCallRequest, ToolExecutionEvent } from "@deepfield/contracts";
import type { ToolDefinition } from "./definition.js";
import { TOOL_FAILURE_MESSAGES } from "./errors.js";
import { toSafeProgress } from "./events.js";
import { ToolPolicy } from "./policy.js";
import { ToolRegistry } from "./registry.js";
import { ToolRunner } from "./runner.js";
import { ToolSet, type ToolGrant } from "./tool-set.js";
import { ToolBudgetLedger } from "./budget.js";
import { FakeAuditSink, FakeRetryClock } from "./testing.js";
import type { ToolRunContext } from "./definition.js";

const SECRET = "sk-secret-value";
const RAW = "provider raw response";

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

function setup(definition: ToolDefinition<typeof echoInput, typeof echoOutput> = echoDefinition()) {
  const clock = new FakeRetryClock();
  const registry = new ToolRegistry();
  registry.register(definition);
  const context: ToolRunContext = {
    traceId: "trace-1",
    actor: "developer_probe",
    toolSet: new ToolSet([echoGrant]),
  };
  const budget = new ToolBudgetLedger({}, () => clock.now());
  const audit = new FakeAuditSink();
  const runner = new ToolRunner({ registry, policy: new ToolPolicy(), budget, audit, clock });
  const signal = new AbortController().signal;
  const events: ToolExecutionEvent[] = [];
  const call: ToolCallRequest = {
    executionId: "exec-1",
    traceId: "trace-1",
    tool: { name: "echo", version: 1 },
    input: { text: "hi" },
  };
  return { runner, call, context, signal, events, audit };
}

function serialize(result: unknown, events: ToolExecutionEvent[], audit: FakeAuditSink): string {
  return JSON.stringify({ result, events, audit: audit.records });
}

describe("ToolRunner secrecy", () => {
  it("does not leak secrets from input, thrown errors or progress into result/events/audit", async () => {
    const leakyError = Object.assign(new Error(RAW), { cause: new Error(SECRET) });
    Object.defineProperty(leakyError, "secret", { value: SECRET, enumerable: true });
    const { runner, context, signal, events, audit } = setup(
      echoDefinition({
        execute: async (_input, _context, _signal, onProgress) => {
          onProgress?.({ kind: "download", bytes: 10, secret: SECRET } as never);
          onProgress?.({ kind: "download", bytes: 1n } as never);
          onProgress?.({ kind: "download", message: "ok", extra: RAW, secret: SECRET } as never);
          throw leakyError;
        },
      }),
    );
    const call: ToolCallRequest = {
      executionId: "exec-1",
      traceId: "trace-1",
      tool: { name: "echo", version: 1 },
      input: { text: SECRET },
    };
    const result = await runner.execute(call, context, signal, (event) => events.push(event));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("executor_failed");
      expect(result.failure.message).toBe(TOOL_FAILURE_MESSAGES["executor_failed"]);
    }
    const serialized = serialize(result, events, audit);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(RAW);
    expect(events.filter((event) => event.type === "progress").length).toBeGreaterThan(0);
    for (const event of events) {
      if (event.type === "progress") {
        expect(JSON.stringify(event.progress)).not.toContain(SECRET);
        expect(JSON.stringify(event.progress)).not.toContain(RAW);
      }
    }
  });

  it("does not leak malformed output into failure surfaces", async () => {
    const { runner, context, signal, events, audit } = setup(
      echoDefinition({
        execute: async () => ({ text: SECRET, leak: RAW } as unknown as { text: string }),
      }),
    );
    const result = await runner.execute(
      { executionId: "exec-1", traceId: "trace-1", tool: { name: "echo", version: 1 }, input: { text: "hi" } },
      context,
      signal,
      (event) => events.push(event),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("invalid_output");
    }
    const serialized = serialize(result, events, audit);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(RAW);
  });

  it("keeps audit records to whitelisted summaries only", async () => {
    const { runner, context, signal, events, audit } = setup();
    const call: ToolCallRequest = {
      executionId: "exec-1",
      traceId: "trace-1",
      tool: { name: "echo", version: 1 },
      input: { text: SECRET },
    };
    await runner.execute(call, context, signal, (event) => events.push(event));
    for (const entry of audit.records) {
      expect(JSON.stringify(entry.record)).not.toContain(SECRET);
      expect(JSON.stringify(entry.record)).not.toContain(RAW);
    }
  });
});

describe("toSafeProgress whitelist", () => {
  it("keeps controlled fields and drops everything else", () => {
    expect(
      toSafeProgress({ kind: "download", bytes: 12, message: "ok", secret: SECRET }),
    ).toEqual({ kind: "download", bytes: 12, message: "ok" });
  });

  it("rejects non-finite numbers and non-JSON values", () => {
    expect(toSafeProgress({ kind: "download", bytes: NaN, percent: Infinity })).toEqual({
      kind: "download",
    });
    expect(toSafeProgress({ kind: "download", bytes: 1n })).toEqual({ kind: "download" });
    expect(toSafeProgress({ kind: "download", fn: () => SECRET })).toEqual({
      kind: "download",
    });
  });

  it("falls back to a fixed kind for non-object progress", () => {
    expect(toSafeProgress(42)).toEqual({ kind: "progress" });
    expect(toSafeProgress(null)).toEqual({ kind: "progress" });
    expect(toSafeProgress([1, 2])).toEqual({ kind: "progress" });
    expect(toSafeProgress({ bytes: 5 })).toEqual({ kind: "progress", bytes: 5 });
  });
});
