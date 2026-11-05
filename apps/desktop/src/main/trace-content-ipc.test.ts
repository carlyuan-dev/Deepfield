import { expect, it, vi } from "vitest";
import { createTraceContentCollector } from "@deepfield/base/trace/runtime";
import { parseTraceContent } from "@deepfield/base/trace";
import { traceContentPolicyFromEnvironment, unwrapTraceContentRun } from "../shared/trace-content.js";
import { AgentWorkerClient } from "./agent-worker-client.js";
import { FakeEndpoint, request } from "./agent-worker-client-test-helpers.js";

it("authorizes only explicitly listed requests, redacts before IPC and validates ownership/mode/bytes at main", async () => {
  const endpoint = new FakeEndpoint(); const stored: string[] = [];
  const modeFor = traceContentPolicyFromEnvironment('{"mode":"benchmark","requestIds":["allowed"]}');
  const client = new AgentWorkerClient(endpoint, { traceContent: { modeFor, record: value => { stored.push(value); return true; } } });
  const allowed = { ...request("allowed"), trace: { rootTraceId: "root", spanId: "parent" } };
  client.send(allowed); client.send({ ...request("other"), trace: allowed.trace });
  expect(endpoint.posted[0]).toMatchObject({ kind: "trace.content.run", mode: "benchmark" });
  expect(endpoint.posted[1]).toMatchObject({ kind: "chat.prompt" });
  const worker = createTraceContentCollector(serialized => { endpoint.emit({ kind: "trace.content", deliveryId: "delivery", serialized }); });
  expect(unwrapTraceContentRun(endpoint.posted[0], worker)).toEqual(allowed);
  worker.capture({ requestId: "allowed", rootTraceId: "root", spanId: "worker" }, { kind: "tool.output", source: "tool.executor" }, () => ({ text: allowed.llm.apiKey }));
  await worker.close();
  expect(stored).toHaveLength(1); expect(stored[0]).not.toContain(allowed.llm.apiKey);
  const record = parseTraceContent(stored[0]!);
  for (const patch of [{ rootTraceId: "foreign" }, { requestId: "other" }, { captureMode: "diagnostic" }, { spanId: "parent" }]) {
    endpoint.emit({ kind: "trace.content", deliveryId: "rejected", serialized: JSON.stringify({ ...record, ...patch }) });
    await Promise.resolve();
    expect(endpoint.posted.at(-1)).toMatchObject({ kind: "trace.content.ack", accepted: false });
  }
  endpoint.emit({ kind: "trace.content", deliveryId: "oversized", serialized: "x".repeat(300000) }); await Promise.resolve();
  const unsafe = { ...record, body: { text: allowed.llm.apiKey }, byteLength: Buffer.byteLength(JSON.stringify({ text: allowed.llm.apiKey })), redacted: true };
  endpoint.emit({ kind: "trace.content", deliveryId: "credential", serialized: JSON.stringify(unsafe) }); await Promise.resolve();
  expect(endpoint.posted.at(-1)).toMatchObject({ kind: "trace.content.ack", accepted: false });
  expect(stored).toHaveLength(1);
  client.dispose();
});
it("keeps invalid/default policy off and optional failures out of business dispatch", () => {
  expect(traceContentPolicyFromEnvironment(undefined)("req")).toBeUndefined();
  expect(traceContentPolicyFromEnvironment('{"mode":"benchmark"}')('req')).toBeUndefined();
  const endpoint = new FakeEndpoint(); const record = vi.fn();
  const client = new AgentWorkerClient(endpoint, { traceContent: { modeFor() { throw new Error("policy"); }, record } });
  const req = { ...request("req"), trace: { rootTraceId: "root", spanId: "parent" } };
  expect(() => client.send(req)).not.toThrow(); expect(endpoint.posted).toEqual([req]); expect(record).not.toHaveBeenCalled(); client.dispose();
});
