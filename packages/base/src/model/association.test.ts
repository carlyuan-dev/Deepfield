import { expect, it } from "vitest";
import { createUsageCollector } from "../usage/runtime.js";
import type { UsageAttempt } from "../usage/index.js";
import { PiModelGateway, type ModelRequestAssociation } from "./runtime.js";
import type { ModelRequestObservation } from "./index.js";

it("does not fail the model when an internal association notification throws after dispatch", async () => {
  const order: string[] = [];
  const usage = createUsageCollector({ now: () => new Date().toISOString(), createId: () => "id", getRecorder: () => undefined });
  const gateway = new PiModelGateway({ usage, snapshotIdentity: () => ({}), onRequestAttempt: () => { order.push("notify"); throw Error("diagnostic hook unavailable"); } });
  const snapshot = { id: "model", name: "model", provider: "openai" as const, protocol: "openai_compatible" as const, baseUrl: "https://fixture.invalid/v1", modelId: "fixture", contextWindow: 32000, apiKey: "not-a-real-key" };
  const stream = gateway.createStream(snapshot)(gateway.createModel(snapshot), { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, {
    apiKey: snapshot.apiKey,
    fetch: async () => { order.push("fetch"); return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }); },
  });
  expect((await stream.result()).stopReason).toBe("stop");
  expect(order).toEqual(["fetch", "notify"]);
});

it("correlates each dispatched observation to its own real usage attempt, never a prepared failure", async () => {
  const records: UsageAttempt[] = [];
  let id = 0;
  const usage = createUsageCollector({ now: () => new Date().toISOString(), createId: () => `id-${++id}`, getRecorder: () => ({ async recordStart(value) { records.push(value); return true; }, async recordFinish(value) { records.push(value); return true; } }) });
  const associations: ModelRequestAssociation[] = [];
  const events: ModelRequestObservation<never, "ordinary">[] = [];
  const gateway = new PiModelGateway<never, "ordinary">({ usage, snapshotIdentity: () => ({}), onRequestAttempt: value => associations.push(value) });
  const snapshot = { id: "model", name: "model", provider: "openai" as const, protocol: "openai_compatible" as const, baseUrl: "https://fixture.invalid/v1", modelId: "fixture", contextWindow: 32000, apiKey: "not-a-real-key" };
  let fetches = 0;
  const fetch: typeof globalThis.fetch = async () => { fetches++; return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }); };
  const model = gateway.createModel(snapshot);
  for (const requestId of ["request-1", "request-2", "prepared-failure"]) {
    const stream = gateway.createStream(snapshot, event => { events.push(event); if (requestId === "prepared-failure") throw Error("storage failure"); });
    const result = stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: snapshot.apiKey, fetch, requestObservation: { requestId, phase: "ordinary", origins: [] } }).result();
    if (requestId === "prepared-failure") await expect(result).rejects.toThrow("storage failure");
    else await result;
  }
  expect(fetches).toBe(2);
  expect(associations).toHaveLength(2);
  const starts = records.filter(record => record.outcome === "running");
  expect(starts).toHaveLength(2);
  for (const [index, association] of associations.entries()) {
    expect(association).toEqual({ requestId: `request-${index + 1}`, modelRequestId: events.find(event => event.requestId === `request-${index + 1}`)!.modelRequestId, operationId: starts[index]!.operationId, attemptId: starts[index]!.attemptId });
  }
  expect(new Set(associations.map(value => value.modelRequestId)).size).toBe(2);
  expect(JSON.stringify(associations)).not.toContain(snapshot.apiKey);
});
