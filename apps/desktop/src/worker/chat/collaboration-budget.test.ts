import { expect, it, vi } from "vitest";
import { createCollaborationBudget } from "./collaboration-budget.js";
import { createLlmUsageTransport } from "../../../../../packages/base/src/model/llm-usage-transport.js";
import { createUsageCollector } from "@deepfield/base/usage/runtime";

it("shares actual dispatch quota across concurrent children and reserves the last request for the parent", async () => {
  let attempts = 0, requests = 0;
  const usage = createUsageCollector({ now: () => new Date().toISOString(), createId: () => String(++attempts), getRecorder: () => undefined });
  const snapshot = { id: "model", name: "model", provider: "openai" as const, protocol: "openai_compatible" as const, baseUrl: "https://fixture.invalid", modelId: "fixture", contextWindow: 32000, apiKey: "fixture-key" };
  const transport = createLlmUsageTransport({ usage, snapshotIdentity: () => ({}) }, snapshot, undefined,
    async () => { requests++; return new Response("ok"); });
  const budget = createCollaborationBudget({ maxRequests: 4 });
  try {
    await budget.run(async () => {
      await transport.fetch("https://fixture.invalid"); // Parent work before first delegation also counts.
      budget.activate();
      const result = await Promise.allSettled(Array.from({ length: 3 }, () => transport.fetch("https://fixture.invalid")));
      expect(result.filter(item => item.status === "fulfilled")).toHaveLength(2);
      expect(requests).toBe(3);
      const before = attempts;
      await expect(transport.fetch("https://fixture.invalid")).rejects.toThrow("budget");
      expect(attempts).toBe(before); // Refused dispatch does not create a Usage attempt.
      await budget.final(() => transport.fetch("https://fixture.invalid"));
      await expect(budget.final(() => transport.fetch("https://fixture.invalid"))).rejects.toThrow("budget");
    });
    expect(requests).toBe(4);
    expect(budget.snapshot().modelCalls).toBe(4);
  } finally { budget.close(); transport.finish("stop"); }
});

it("restores consumed requests and execution time without replenishing either", async () => {
  let now = 0;
  const budget = createCollaborationBudget({ modelCalls: 31, remainingMs: 61_000, active: true, now: () => now });
  try {
    expect(budget.shouldFinalize).toBe(true);
    now = 2_000;
    expect(budget.snapshot()).toEqual({ modelCalls: 31, remainingMs: 59_000 });
  } finally { budget.close(); }
});

it("interrupts ordinary work before the hard deadline while preserving the final answer window", async () => {
  vi.useFakeTimers();
  const budget = createCollaborationBudget({ remainingMs: 90_000, active: true });
  try {
    await vi.advanceTimersByTimeAsync(29_999);
    expect(budget.workSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(budget.workSignal.aborted).toBe(true);
    expect(budget.signal.aborted).toBe(false);
    expect(budget.shouldFinalize).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(budget.signal.aborted).toBe(true);
  } finally { budget.close(); vi.useRealTimers(); }
});


it("preserves an admission rejection when the model loop wraps it as a provider failure", async () => {
  const { admitModelRequest } = await import("../../../../../packages/base/src/model/request-admission.js");
  const budget = createCollaborationBudget({ active: true, modelCalls: 31 });
  try {
    await expect(budget.run(async () => {
      try { admitModelRequest(); } catch { throw new Error("generic provider failure"); }
    })).rejects.toMatchObject({ code: "model_budget_exceeded" });
    // A sibling failure without a rejected dispatch must keep its own cause.
    await expect(budget.run(async () => { throw new Error("unrelated failure"); })).rejects.toThrow("unrelated failure");
  } finally { budget.close(); }
});
