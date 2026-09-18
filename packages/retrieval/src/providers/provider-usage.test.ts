import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { createSearchProvider } from "./provider-registry.js";
import type { ProviderTransport } from "../provider-http-client.js";
const snapshot = { id: "search", name: "Search", provider: "tavily" as const, baseUrl: "https://fixture.invalid", apiKey: "secret", options: {} };
it("observes only dispatched search, including HTTP200 application failure and successful empty results", async () => {
  const events: unknown[] = [];
  let body = { error: "not allowed" } as object;
  const transport: ProviderTransport = { async request() { return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from(JSON.stringify(body))]), destroy() {} }; } };
  const provider = createSearchProvider(snapshot, { transport, onDispatch: () => { events.push("start"); return (outcome, count) => events.push([outcome, count]); } });
  await expect(provider.search({ query: "", maxResults: 5 }, new AbortController().signal)).rejects.toThrow();
  expect(events).toEqual([]);
  await expect(provider.search({ query: "test", maxResults: 5 }, new AbortController().signal)).rejects.toThrow();
  expect(events).toEqual(["start", ["failed", null]]);
  body = { results: [] };
  const result = await provider.search({ query: "test", maxResults: 5 }, new AbortController().signal);
  expect(result.results).toEqual([]);
  expect(events.slice(2)).toEqual(["start", ["succeeded", 0]]);
});
it("records transport failure but not a pre-cancelled request", async () => {
  const events: unknown[] = [];
  const provider = createSearchProvider(snapshot, { transport: { async request() { throw Error("network secret"); } }, onDispatch: () => (outcome, count) => events.push([outcome, count]) });
  await expect(provider.search({ query: "test", maxResults: 5 }, AbortSignal.abort())).rejects.toThrow();
  expect(events).toEqual([]);
  await expect(provider.search({ query: "test", maxResults: 5 }, new AbortController().signal)).rejects.toThrow();
  expect(events).toEqual([["failed", null]]);
});
it("reports in-flight cancellation synchronously so shutdown can flush its terminal record", async () => {
  const events: unknown[] = []; const controller = new AbortController();
  const provider = createSearchProvider(snapshot, { transport: { request: () => new Promise(() => {}) }, onDispatch: () => { events.push("start"); return (outcome) => events.push(outcome); } });
  const request = provider.search({ query: "test", maxResults: 5 }, controller.signal);
  controller.abort();
  expect(events).toEqual(["start", "cancelled"]);
  await expect(request).rejects.toThrow();
  expect(events).toEqual(["start", "cancelled"]);
});
