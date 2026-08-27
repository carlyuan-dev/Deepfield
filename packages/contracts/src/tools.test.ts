import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  JsonObjectSchema,
  JsonValueSchema,
  ToolCallRequestSchema,
  ToolExecutionEventSchema,
  ToolExecutionResultSchema,
  ToolManifestEntrySchema,
} from "./tools.js";

const validCall = {
  executionId: "exec-1",
  traceId: "trace-1",
  tool: { name: "fetch_url", version: 1 },
  input: { url: "https://example.com" },
};

describe("ToolCallRequestSchema", () => {
  it("accepts a minimal serializable call", () => {
    expect(Value.Check(ToolCallRequestSchema, validCall)).toBe(true);
  });

  it("rejects blank tool names", () => {
    expect(
      Value.Check(ToolCallRequestSchema, { ...validCall, tool: { name: "", version: 1 } }),
    ).toBe(false);
  });

  it("rejects version 0", () => {
    expect(
      Value.Check(ToolCallRequestSchema, { ...validCall, tool: { name: "fetch_url", version: 0 } }),
    ).toBe(false);
  });

  it("rejects extra properties at every trust boundary", () => {
    expect(Value.Check(ToolCallRequestSchema, { ...validCall, extra: 1 })).toBe(false);
    expect(
      Value.Check(ToolCallRequestSchema, {
        ...validCall,
        tool: { name: "fetch_url", version: 1, extra: true },
      }),
    ).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(Value.Check(ToolCallRequestSchema, { ...validCall, input: "https://example.com" })).toBe(false);
    expect(Value.Check(ToolCallRequestSchema, { ...validCall, input: null })).toBe(false);
    expect(Value.Check(ToolCallRequestSchema, { ...validCall, input: 42 })).toBe(false);
  });

  it("rejects non-string execution and trace ids", () => {
    expect(Value.Check(ToolCallRequestSchema, { ...validCall, executionId: 1 })).toBe(false);
    expect(Value.Check(ToolCallRequestSchema, { ...validCall, traceId: null })).toBe(false);
  });
});

const completedResult = {
  executionId: "exec-1",
  traceId: "trace-1",
  tool: { name: "fetch_url", version: 1 },
  status: "completed",
  output: { resourceId: "res-1" },
  attempts: 1,
};

describe("ToolExecutionResultSchema", () => {
  it("accepts a minimal completed result", () => {
    expect(Value.Check(ToolExecutionResultSchema, completedResult)).toBe(true);
  });

  it("accepts a failed result carrying a structured failure", () => {
    expect(
      Value.Check(ToolExecutionResultSchema, {
        executionId: "exec-1",
        traceId: "trace-1",
        tool: { name: "fetch_url", version: 1 },
        status: "failed",
        failure: { code: "url_blocked", message: "blocked", retryable: false, attempts: 1 },
        attempts: 1,
      }),
    ).toBe(true);
  });

  it("rejects malformed success results", () => {
    expect(Value.Check(ToolExecutionResultSchema, { ...completedResult, status: "done" })).toBe(false);
    expect(Value.Check(ToolExecutionResultSchema, { ...completedResult, extra: true })).toBe(false);
  });

  it("rejects completed results without an output", () => {
    expect(
      Value.Check(ToolExecutionResultSchema, {
        executionId: "exec-1",
        traceId: "trace-1",
        tool: { name: "fetch_url", version: 1 },
        status: "completed",
        attempts: 1,
      }),
    ).toBe(false);
  });

  it("rejects failed results without a failure object", () => {
    expect(
      Value.Check(ToolExecutionResultSchema, {
        executionId: "exec-1",
        traceId: "trace-1",
        tool: { name: "fetch_url", version: 1 },
        status: "failed",
        attempts: 1,
      }),
    ).toBe(false);
  });

  it("rejects malformed failure payloads", () => {
    expect(
      Value.Check(ToolExecutionResultSchema, {
        executionId: "exec-1",
        traceId: "trace-1",
        tool: { name: "fetch_url", version: 1 },
        status: "failed",
        failure: { code: "url_blocked", message: "blocked", retryable: false },
        attempts: 1,
      }),
    ).toBe(false);
  });
});

const baseEvent = {
  executionId: "exec-1",
  traceId: "trace-1",
  tool: { name: "fetch_url", version: 1 },
  sequence: 0,
  timestamp: 1700000000000,
};

describe("ToolExecutionEventSchema", () => {
  it("accepts minimal lifecycle events", () => {
    expect(Value.Check(ToolExecutionEventSchema, { ...baseEvent, type: "accepted" })).toBe(true);
    expect(Value.Check(ToolExecutionEventSchema, { ...baseEvent, type: "completed" })).toBe(true);
  });

  it("rejects events without execution correlation", () => {
    expect(
      Value.Check(ToolExecutionEventSchema, {
        traceId: "trace-1",
        tool: { name: "fetch_url", version: 1 },
        sequence: 0,
        timestamp: 1700000000000,
        type: "accepted",
      }),
    ).toBe(false);
  });

  it("rejects events without trace correlation", () => {
    expect(
      Value.Check(ToolExecutionEventSchema, {
        executionId: "exec-1",
        tool: { name: "fetch_url", version: 1 },
        sequence: 0,
        timestamp: 1700000000000,
        type: "accepted",
      }),
    ).toBe(false);
  });

  it("rejects unknown event types and extra properties", () => {
    expect(Value.Check(ToolExecutionEventSchema, { ...baseEvent, type: "mystery" })).toBe(false);
    expect(Value.Check(ToolExecutionEventSchema, { ...baseEvent, type: "accepted", extra: true })).toBe(false);
  });

  it("rejects failed events without a failure payload", () => {
    expect(Value.Check(ToolExecutionEventSchema, { ...baseEvent, type: "failed" })).toBe(false);
  });
});

const manifestEntry = {
  identity: { name: "fetch_url", version: 1 },
  label: "Fetch URL",
  description: "Fetch a public HTML page.",
  effect: "network.read.public",
  timeoutMs: 30_000,
  retry: { maxRetries: 2, backoffMs: 250 },
  concurrency: 2,
  meter: { category: "fetch", countsBytes: true, countsTime: true },
};

describe("ToolManifestEntrySchema", () => {
  it("accepts a serializable manifest entry without an executor", () => {
    expect(Value.Check(ToolManifestEntrySchema, manifestEntry)).toBe(true);
  });

  it("rejects entries that leak an executor function", () => {
    expect(
      Value.Check(ToolManifestEntrySchema, { ...manifestEntry, execute: async () => ({}) }),
    ).toBe(false);
  });

  it("rejects invalid retry limits", () => {
    expect(
      Value.Check(ToolManifestEntrySchema, { ...manifestEntry, retry: { maxRetries: 3, backoffMs: 250 } }),
    ).toBe(false);
  });
});

describe("JsonValueSchema", () => {
  it("accepts JSON-safe primitives, arrays and objects", () => {
    const values = [
      null,
      true,
      false,
      0,
      -1.5,
      42,
      "text",
      [],
      [1, "a", null, { b: true }],
      { a: 1, b: { c: [1, "x", null] } },
    ];
    for (const value of values) {
      expect(Value.Check(JsonValueSchema, value)).toBe(true);
    }
  });

  it("rejects non-JSON values at the top level", () => {
    expect(Value.Check(JsonValueSchema, undefined)).toBe(false);
    expect(Value.Check(JsonValueSchema, () => 1)).toBe(false);
    expect(Value.Check(JsonValueSchema, Symbol("x"))).toBe(false);
    expect(Value.Check(JsonValueSchema, 1n)).toBe(false);
    expect(Value.Check(JsonValueSchema, NaN)).toBe(false);
    expect(Value.Check(JsonValueSchema, Infinity)).toBe(false);
    expect(Value.Check(JsonValueSchema, -Infinity)).toBe(false);
  });

  it("rejects non-JSON values nested at any depth", () => {
    expect(Value.Check(JsonValueSchema, { a: { b: [1, undefined] } })).toBe(false);
    expect(Value.Check(JsonValueSchema, { a: { b: () => 1 } })).toBe(false);
    expect(Value.Check(JsonValueSchema, [1, { a: NaN }])).toBe(false);
    expect(Value.Check(JsonValueSchema, { a: 1n })).toBe(false);
    expect(Value.Check(JsonValueSchema, { a: Symbol("x") })).toBe(false);
    expect(Value.Check(JsonValueSchema, { u: undefined })).toBe(false);
  });
});

describe("JsonObjectSchema", () => {
  it("accepts plain JSON objects with nested JSON values", () => {
    expect(Value.Check(JsonObjectSchema, {})).toBe(true);
    expect(
      Value.Check(JsonObjectSchema, {
        url: "https://example.com",
        meta: { n: 1, ok: true },
        tags: ["a", null],
      }),
    ).toBe(true);
  });

  it("rejects top-level arrays and scalars", () => {
    expect(Value.Check(JsonObjectSchema, [1, 2])).toBe(false);
    expect(Value.Check(JsonObjectSchema, "text")).toBe(false);
    expect(Value.Check(JsonObjectSchema, 42)).toBe(false);
    expect(Value.Check(JsonObjectSchema, null)).toBe(false);
  });

  it("rejects non-JSON values at any depth", () => {
    expect(Value.Check(JsonObjectSchema, { fn() {} })).toBe(false);
    expect(Value.Check(JsonObjectSchema, { b: 1n })).toBe(false);
    expect(Value.Check(JsonObjectSchema, { u: undefined })).toBe(false);
    expect(Value.Check(JsonObjectSchema, { n: NaN })).toBe(false);
  });
});

describe("main-window repro guards", () => {
  it("rejects functions, bigint and undefined inside ToolCallRequest input (repro #1)", () => {
    expect(Value.Check(ToolCallRequestSchema, { ...validCall, input: { fn() {} } })).toBe(false);
    expect(Value.Check(ToolCallRequestSchema, { ...validCall, input: { bigint: 1n } })).toBe(false);
    expect(
      Value.Check(ToolCallRequestSchema, { ...validCall, input: { missing: undefined } }),
    ).toBe(false);
  });

  it("rejects function output in completed results (repro #2)", () => {
    expect(Value.Check(ToolExecutionResultSchema, { ...completedResult, output: () => 1 })).toBe(false);
  });

  it("rejects BigInt progress in events (repro #3)", () => {
    expect(
      Value.Check(ToolExecutionEventSchema, { ...baseEvent, type: "progress", progress: 1n }),
    ).toBe(false);
    expect(
      Value.Check(ToolExecutionEventSchema, {
        ...baseEvent,
        type: "progress",
        progress: { bytes: 1n },
      }),
    ).toBe(false);
  });

  it("rejects empty execution id, trace id, failure code and failure message", () => {
    expect(Value.Check(ToolCallRequestSchema, { ...validCall, executionId: "" })).toBe(false);
    expect(Value.Check(ToolCallRequestSchema, { ...validCall, traceId: "" })).toBe(false);
    expect(
      Value.Check(ToolExecutionResultSchema, {
        ...completedResult,
        status: "failed",
        failure: { code: "", message: "blocked", retryable: false, attempts: 1 },
      }),
    ).toBe(false);
    expect(
      Value.Check(ToolExecutionResultSchema, {
        ...completedResult,
        status: "failed",
        failure: { code: "url_blocked", message: "", retryable: false, attempts: 1 },
      }),
    ).toBe(false);
  });

  it("rejects whitespace-only tool names", () => {
    expect(
      Value.Check(ToolCallRequestSchema, { ...validCall, tool: { name: " ", version: 1 } }),
    ).toBe(false);
  });
});
