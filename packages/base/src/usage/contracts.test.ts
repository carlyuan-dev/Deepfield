import { describe, expect, it } from "vitest";
import { normalizeUsageMetrics, parseUsageAttempt } from "./contracts.js";

const attempt = {
  attemptId: "a", operationId: "op", sourceId: "chat", serviceKind: "llm" as const,
  profileId: "p1", profileName: "First", providerId: "provider", modelId: "model",
  configRevisionId: "config-1", startedAt: "2026-09-18T00:00:00.000Z",
  finishedAt: "2026-09-18T00:00:01.000Z", outcome: "succeeded" as const,
  durationMs: 1000, revision: 2, attemptCountStatus: "complete" as const, errorCode: null,
  inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: null,
  totalTokens: 120, usageStatus: "reported" as const, resultCount: null,
};

describe("usage validation", () => {
  it.each([NaN, Infinity, -1, 1.2, Number.MAX_SAFE_INTEGER + 1])("rejects invalid metrics %s", (inputTokens) => {
    expect(() => parseUsageAttempt({ ...attempt, inputTokens })).toThrow();
  });
  it.each(["apiKey", "prompt", "query", "headers", "response", "rawError"])("rejects unlisted field %s before storing", (field) => {
    expect(() => parseUsageAttempt({ ...attempt, [field]: "secret" })).toThrow();
  });
  it("normalizes known totals without adding cache subsets or inventing zero", () => {
    expect(normalizeUsageMetrics({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, totalTokens: 999 }))
      .toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: null, totalTokens: 120, usageStatus: "reported" });
    expect(normalizeUsageMetrics({ totalTokens: 50 })).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: 50, usageStatus: "partial" });
    expect(normalizeUsageMetrics({})).toMatchObject({ inputTokens: null, totalTokens: null, usageStatus: "unknown" });
    expect(normalizeUsageMetrics({ inputTokens: 0, outputTokens: 0 })).toMatchObject({ totalTokens: 0, usageStatus: "reported" });
  });
  it("rejects contradictory normalized metrics, dates and unsafe identifiers", () => {
    for (const change of [
      { cacheReadTokens: 101 }, { cacheReadTokens: 60, cacheWriteTokens: 50 },
      { totalTokens: 999 }, { usageStatus: "unknown" }, { sourceId: "free form text" },
      { finishedAt: "2026-09-17T00:00:00.000Z" }, { startedAt: "not a date" },
      { errorCode: "raw error: request body" }, { serviceKind: "search" },
    ]) expect(() => parseUsageAttempt({ ...attempt, ...change })).toThrow();
  });
  it("accepts upstream model aliases with spaces and Unicode", () => {
    expect(parseUsageAttempt({ ...attempt, modelId: "模型 alias (latest)" }).modelId).toBe("模型 alias (latest)");
  });
});
