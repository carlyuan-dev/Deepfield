import { afterEach, expect, it, vi } from "vitest";
import { createUsageCollector } from "../usage/runtime.js";
import { PiModelGateway } from "./runtime.js";
import { configureTraceContent, createTraceContentCollector, withTrace } from "../trace/runtime.js";
import { parseTraceContent } from "../trace/content.js";

afterEach(() => configureTraceContent(undefined));
it.each(["openai_compatible", "anthropic_messages"] as const)("captures final %s HTTP JSON after onPayload and observes the existing Pi result without another reader", async protocol => {
  const records: string[] = [];
  const collector = createTraceContentCollector(value => { records.push(value); });
  collector.authorize("req", "root", "benchmark"); configureTraceContent(collector);
  const usage = createUsageCollector({ now: () => new Date().toISOString(), createId: () => "attempt", getRecorder: () => undefined });
  const gateway = new PiModelGateway({ usage, snapshotIdentity: () => ({}) });
  const snapshot = { id: "profile", name: "fixture", provider: "custom" as const, protocol, baseUrl: "https://fixture.invalid", modelId: "fixture", contextWindow: 32000, apiKey: "credential-sentinel" };
  const data = protocol === "openai_compatible"
    ? 'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    : ['event: message_start\ndata: {"type":"message_start","message":{"id":"fixture","role":"assistant","model":"fixture","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}', 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}', 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"reply"}}', 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}', 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}', 'event: message_stop\ndata: {"type":"message_stop"}'].join('\n\n') + '\n\n';
  const response = new Response(data, { headers: { "content-type": "text/event-stream" } });
  const reader = vi.spyOn(response.body!, "getReader"); const clone = vi.spyOn(response, "clone");
  let sent: unknown;
  const message = await withTrace({ requestId: "req", rootTraceId: "root", spanId: "model", modelRequestId: "model-request" }, () => gateway.createStream(snapshot)(gateway.createModel(snapshot), { messages: [{ role: "user", content: "original", timestamp: 1 }] }, {
    apiKey: snapshot.apiKey,
    onPayload: payload => ({ ...(payload as object), metadata: { final_marker: "changed", api_key: snapshot.apiKey }, messages: [{ role: "user", content: "changed credential-sentinel" }] }),
    fetch: async (_input, init) => { sent = JSON.parse(init!.body as string); return response; },
  }).result());
  await collector.close();
  expect(message.stopReason).toBe("stop"); expect(message.content).toEqual([{ type: "text", text: "reply" }]);
  expect(reader).toHaveBeenCalledTimes(1); expect(clone).not.toHaveBeenCalled();
  expect(sent).toMatchObject({ metadata: { final_marker: "changed" } });
  const parsed = records.map(parseTraceContent);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]!.modelRequestId).toBeTruthy();
  expect(parsed[0]!.spanId).toBe(parsed[1]!.spanId);
  expect(parsed[0]!.spanId).not.toBe("model");
  expect(parsed[0]).toMatchObject({ kind: "model.request", usageAttemptId: "attempt", redacted: true, completeness: "complete", body: { metadata: { final_marker: "changed", api_key: "[REDACTED]" }, messages: [{ role: "user", content: "changed [REDACTED]" }] } });
  expect(parsed[1]).toMatchObject({ kind: "model.response", modelRequestId: parsed[0]!.modelRequestId, source: "pi.assistant_message", body: { content: [{ type: "text", text: "reply" }], stopReason: "stop" } });
  expect(records.join("")).not.toContain(snapshot.apiKey);
});
