import { afterEach, expect, it, vi } from "vitest";
import type { UsageAttempt } from "@deepfield/base/usage";
import { PiModelGateway } from "./model-gateway.js";
import { configureUsageRecorder, createLlmUsageTransport } from "./usage-collection.js";
import { defaultPiRuntime } from "../worker/agent/pi-chat-agent.js";

const snapshot = { id: "中文 profile", name: "测试", provider: "openai" as const, protocol: "openai_compatible" as const, baseUrl: "https://fixture.invalid/v1", modelId: "model", contextWindow: 32000, apiKey: "secret-never-record", configRevisionId: "revision-1" };
afterEach(() => { vi.unstubAllGlobals(); configureUsageRecorder(undefined); });
function recording() {
  const records: UsageAttempt[] = [];
  configureUsageRecorder({ async recordStart(value) { records.push(value); return true; }, async recordFinish(value) { records.push(value); return true; } });
  return records;
}
function response(usage?: unknown) {
  return new Response(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], ...(usage === undefined ? {} : { usage }) })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
it.each(["direct", "stream"])("collects %s raw cache usage once, normalizes legacy IDs, and preserves business output", async (mode) => {
  const records = recording();
  vi.stubGlobal("fetch", async () => response({ prompt_tokens: 20, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 8 } }));
  const gateway = new PiModelGateway();
  if (mode === "direct") expect(await gateway.completeText(snapshot, "s", "p")).toBe("ok");
  else {
    const session = defaultPiRuntime(gateway).createSession(snapshot)!;
    const stream = await session.streamFn(session.model, { messages: [{ role: "user", content: "p", timestamp: 1 }] }, { apiKey: snapshot.apiKey });
    expect((await stream.result()).content).toEqual([{ type: "text", text: "ok" }]);
  }
  await Promise.resolve();
  const ends = records.filter((r) => r.outcome !== "running");
  expect(ends).toHaveLength(1);
  expect(ends[0]).toMatchObject({ inputTokens: 20, outputTokens: 3, totalTokens: 23, cacheReadTokens: 8, cacheWriteTokens: null, outcome: "succeeded", usageStatus: "reported" });
  expect(ends[0]?.profileId).toMatch(/^legacy-profile-[a-f0-9]+$/);
  expect(JSON.stringify(records)).not.toContain("secret-never-record");
});
it.each([undefined, { prompt_tokens: 0, completion_tokens: 0 }])("never turns missing provider usage into SDK zero (%j)", async (usage) => {
  const records = recording(); vi.stubGlobal("fetch", async () => response(usage));
  await new PiModelGateway().completeText(snapshot, "s", "p");
  expect(records.at(-1)).toMatchObject(usage === undefined ? { usageStatus: "unknown", totalTokens: null } : { usageStatus: "reported", totalTokens: 0 });
});
it("records network failure and separately records the next business attempt without SDK retries", async () => {
  const records = recording(); let calls = 0;
  vi.stubGlobal("fetch", async () => { calls++; if (calls === 1) throw new TypeError("secret raw error"); return response(); });
  const gateway = new PiModelGateway();
  await expect(gateway.completeText(snapshot, "s", "p")).rejects.toThrow();
  await gateway.completeText(snapshot, "s", "p");
  expect(calls).toBe(2);
  const ends = records.filter((r) => r.outcome !== "running");
  expect(ends.map((r) => r.outcome)).toEqual(["failed", "succeeded"]);
  expect(new Set(ends.map((r) => r.attemptId)).size).toBe(2);
});
it("does not record local pre-abort; recorder exceptions cannot fail a request", async () => {
  const records = recording(); const signal = AbortSignal.abort();
  vi.stubGlobal("fetch", async () => response());
  await expect(new PiModelGateway().completeText(snapshot, "s", "p", signal)).rejects.toThrow();
  expect(records).toHaveLength(0);
  configureUsageRecorder({ recordStart() { throw Error("db"); }, recordFinish() { throw Error("db"); } });
  expect(await new PiModelGateway().completeText(snapshot, "s", "p")).toBe("ok");
});
it("normalizes explicit OpenAI cache writes without counting reasoning twice", async () => {
  const records = recording();
  vi.stubGlobal("fetch", async () => response({ prompt_tokens: 20, completion_tokens: 3, prompt_tokens_details: { cache_write_tokens: 5 }, cached_tokens: 7, completion_tokens_details: { reasoning_tokens: 2 } }));
  await new PiModelGateway().completeText(snapshot, "s", "p");
  expect(records.at(-1)).toMatchObject({ inputTokens: 20, outputTokens: 3, totalTokens: 23, cacheReadTokens: 7, cacheWriteTokens: 5 });
});
it("retains authoritative Anthropic usage on cancellation and preserves bytes without eager draining", async () => {
  const records = recording(); const controller = new AbortController(); let pulls = 0;
  const chunks = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}}}\n\n',
    'data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
  ];
  const transport = createLlmUsageTransport({ ...snapshot, protocol: "anthropic_messages" }, controller.signal, async () => new Response(new ReadableStream({ pull(stream) { const chunk = chunks[pulls++]; if (chunk) stream.enqueue(new TextEncoder().encode(chunk)); }, cancel() {} }, { highWaterMark: 0 })));
  const result = await transport.fetch("https://fixture.invalid");
  expect(pulls).toBe(0);
  const reader = result.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(chunks[0]);
  expect(pulls).toBe(1);
  await reader.read(); controller.abort(); await reader.cancel(); transport.finish("aborted");
  const ends = records.filter((record) => record.outcome !== "running");
  expect(ends).toHaveLength(1);
  expect(ends[0]).toMatchObject({ outcome: "cancelled", inputTokens: 17, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 21 });
});
it.each(["direct", "stream"])("classifies %s HTTP200 SSE errors as failed when SDK cancels the still-open body", async (mode) => {
  const records = recording(); let cancelled = false;
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}],"usage":{"prompt_tokens":20,"completion_tokens":3}}\n\ndata: {"error":{"message":"provider failure","type":"server_error"}}\n\n'));
  }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } }));
  const gateway = new PiModelGateway();
  if (mode === "direct") await expect(gateway.completeText(snapshot, "s", "p")).rejects.toThrow();
  else {
    const session = defaultPiRuntime(gateway).createSession(snapshot)!;
    const stream = await session.streamFn(session.model, { messages: [{ role: "user", content: "p", timestamp: 1 }] }, { apiKey: snapshot.apiKey });
    expect((await stream.result()).stopReason).toBe("error");
  }
  await Promise.resolve();
  expect(cancelled).toBe(true);
  expect(records.filter((record) => record.outcome !== "running")).toEqual([expect.objectContaining({ outcome: "failed", inputTokens: 20, outputTokens: 3, totalTokens: 23 })]);
});
it("SDK-owned abort and body cleanup alone do not imply caller cancellation", async () => {
  const records = recording(); const sdkController = new AbortController();
  const transport = createLlmUsageTransport(snapshot, undefined, async () => response({ prompt_tokens: 1, completion_tokens: 2 }));
  const result = await transport.fetch("https://fixture.invalid", { signal: sdkController.signal });
  const reader = result.body!.getReader(); await reader.read(); sdkController.abort(); await reader.cancel();
  transport.finish("aborted");
  expect(records.at(-1)).toMatchObject({ outcome: "failed", inputTokens: 1, outputTokens: 2 });
});
