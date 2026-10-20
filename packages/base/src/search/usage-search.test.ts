import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { createMeteredSearchProvider } from "./usage-search.js";
import { createUsageCollector } from "../usage/collector.js";
import type { UsageStart, UsageFinish } from "../usage/contracts.js";

it("keeps identity collection failures from preventing a dispatched search", async () => {
  let dispatches = 0;
  const provider = createMeteredSearchProvider({
    snapshotIdentity() { throw new Error("identity collection unavailable"); },
    usage: { startAttempt() { throw new Error("must not be reached"); } },
  }, { id: "profile", name: "Search", provider: "tavily", baseUrl: "https://fixture.invalid", apiKey: "fixture-key", options: {} }, {
    transport: { async request() {
      dispatches += 1;
      return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from('{"results":[]}')]), destroy() {} };
    } },
  });
  await expect(provider.search({ query: "test", maxResults: 5 }, new AbortController().signal)).resolves.toEqual({ provider: "tavily", results: [] });
  expect(dispatches).toBe(1);
});

it("binds dispatched attempts to the injected snapshot identity without credentials or configuration rereads", async () => {
  const starts: UsageStart[] = []; const finishes: UsageFinish[] = [];
  let id = 0;
  const collector = createUsageCollector({ createId: () => `id-${++id}`, now: () => "2026-10-20T00:00:00.000Z", getRecorder: () => ({ async recordStart(start) { starts.push(start); return true; }, async recordFinish(finish) { finishes.push(finish); return true; } }) });
  const identity = {};
  const identities: object[] = [];
  const snapshot = { id: "profile", name: "Search", provider: "tavily" as const, baseUrl: "https://fixture.invalid", apiKey: "never-record-key", options: {}, configRevisionId: "revision-1" };
  const provider = createMeteredSearchProvider({ snapshotIdentity: value => { expect(value).toBe(snapshot); return identity; }, usage: { startAttempt(metadata, token) { identities.push(token!); return collector.startAttempt(metadata, { sourceId: "chat", operationId: "operation" }, token); } } }, snapshot, {
    transport: { async request() { return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from('{"results":[]}')]), destroy() {} }; } },
  });
  await expect(provider.search({ query: "", maxResults: 5 }, new AbortController().signal)).rejects.toThrow();
  await expect(provider.search({ query: "test", maxResults: 5 }, AbortSignal.abort())).rejects.toThrow();
  expect(starts).toEqual([]);
  await provider.search({ query: "test", maxResults: 5 }, new AbortController().signal);
  expect(identities).toEqual([identity]);
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ profileId: "profile", configRevisionId: "revision-1", serviceKind: "search" });
  expect(finishes).toHaveLength(1);
  expect(finishes[0]).toMatchObject({ outcome: "succeeded", resultCount: 0 });
  expect(JSON.stringify({ starts, finishes })).not.toContain("never-record-key");
});
