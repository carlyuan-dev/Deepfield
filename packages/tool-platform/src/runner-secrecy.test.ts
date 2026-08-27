import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ToolCallRequest, ToolExecutionEvent } from "@deepfield/contracts";
import type { ToolDefinition, ToolRunContext } from "./definition.js";
import { TOOL_FAILURE_MESSAGES, ToolExecutionError } from "./errors.js";
import { toSafeProgress } from "./events.js";
import { ToolPolicy } from "./policy.js";
import { ToolRegistry } from "./registry.js";
import { ToolRunner } from "./runner.js";
import { ToolSet, type ToolGrant } from "./tool-set.js";
import { ToolBudgetLedger } from "./budget.js";
import { FakeAuditSink, FakeRetryClock } from "./testing.js";

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

describe("ToolRunner secrecy (focused revision)", () => {
  it("does not leak arbitrary executor failure metadata", async () => {
    const { runner, context, signal, events, audit } = setup(
      echoDefinition({
        execute: async () => {
          throw new ToolExecutionError("rate_limited", {
            httpStatus: 429,
            secret: SECRET,
            headers: RAW,
          });
        },
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
      expect(result.failure.code).toBe("rate_limited");
      expect(result.failure.metadata).toEqual({ httpStatus: 429 });
    }
    const serialized = serialize(result, events, audit);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(RAW);
  });

  it("does not leak secrets from input, thrown errors or progress into result/events/audit", async () => {
    const leakyError = Object.assign(new Error(RAW), { cause: new Error(SECRET) });
    Object.defineProperty(leakyError, "secret", { value: SECRET, enumerable: true });
    const { runner, context, signal, events, audit } = setup(
      echoDefinition({
        execute: async (_input, _context, _signal, onProgress) => {
          onProgress?.({ kind: "download", bytes: 10, secret: SECRET } as never);
          onProgress?.({ kind: "download", bytes: 1n } as never);
          onProgress?.({ kind: SECRET, message: SECRET, extra: RAW } as never);
          throw leakyError;
        },
      }),
    );
    const result = await runner.execute(
      { executionId: "exec-1", traceId: "trace-1", tool: { name: "echo", version: 1 }, input: { text: SECRET } },
      context,
      signal,
      (event) => events.push(event),
    );
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
        expect(JSON.stringify(event.progress)).not.toContain("message");
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

  it("ToolExecutionError copies and freezes whitelisted metadata at construction", () => {
    const metadata = { httpStatus: 429, secret: SECRET };
    const error = new ToolExecutionError("rate_limited", metadata);
    metadata.httpStatus = 500;
    metadata.secret = "changed";
    expect(error.metadata).toEqual({ httpStatus: 429 });
    expect(Object.isFrozen(error.metadata)).toBe(true);
    expect(error.message).toBe(TOOL_FAILURE_MESSAGES["rate_limited"]);
  });
});

describe("toSafeProgress whitelist (focused revision)", () => {
  it("keeps only the controlled kind plus integer bytes and bounded percent", () => {
    expect(toSafeProgress({ kind: "fetching", bytes: 10, percent: 50 })).toEqual({
      kind: "fetching",
      bytes: 10,
      percent: 50,
    });
    expect(toSafeProgress({ kind: "searching", bytes: 0, percent: 0 })).toEqual({
      kind: "searching",
      bytes: 0,
      percent: 0,
    });
  });

  it("drops unknown kinds, arbitrary strings and non-JSON values", () => {
    expect(toSafeProgress({ kind: "download", message: SECRET, secret: SECRET })).toEqual({
      kind: "progress",
    });
    expect(toSafeProgress({ kind: SECRET, message: SECRET, extra: RAW })).toEqual({
      kind: "progress",
    });
    expect(toSafeProgress({ kind: "fetching", bytes: 1.5 })).toEqual({ kind: "fetching" });
    expect(toSafeProgress({ kind: "fetching", percent: 150 })).toEqual({ kind: "fetching" });
    expect(toSafeProgress({ kind: "fetching", percent: -1 })).toEqual({ kind: "fetching" });
    expect(toSafeProgress({ kind: "fetching", bytes: 1n })).toEqual({ kind: "fetching" });
    expect(toSafeProgress({ kind: "fetching", fn: () => SECRET })).toEqual({ kind: "fetching" });
    expect(toSafeProgress({ bytes: 5 })).toEqual({ kind: "progress", bytes: 5 });
  });

  it("falls back to a fixed kind for non-object progress and freezes the output", () => {
    expect(toSafeProgress(42)).toEqual({ kind: "progress" });
    expect(toSafeProgress(null)).toEqual({ kind: "progress" });
    expect(toSafeProgress([1, 2])).toEqual({ kind: "progress" });
    const safe = toSafeProgress({ kind: "parsing", bytes: 3 });
    expect(Object.isFrozen(safe)).toBe(true);
    expect(() => {
      (safe as unknown as Record<string, unknown>)["secret"] = SECRET;
    }).toThrow(TypeError);
  });
});
