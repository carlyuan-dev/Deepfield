import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PiModelGateway } from "../../shared/model-gateway.js";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts";
import type { ModelRequestObservation } from "@deepfield/capability-sdk";
import { Type } from "typebox";
import { FakeAuditSink, FakeRetryClock, ToolBudgetLedger, ToolPolicy, ToolRegistry, ToolRunner, ToolSet } from "@deepfield/tool-platform";
import { createPiAgentTools } from "../tools/pi-tool-adapter.js";
import { defaultPiRuntime } from "./pi-default-runtime.js";
import { createCapabilityAgentRuntime } from "../capabilities/agent-runtime.js";

function completion(protocol: LlmRuntimeSnapshot["protocol"], call?: { id: string; query: string }, text = "本轮最终报告，引用所获得的检索依据。") {
  if (protocol === "openai_compatible") {
    const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query: call.query }) } }] } : { role: "assistant", content: text };
    return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }
  const events = [
    { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: call ? { type: "tool_use", id: call.id, name: "web_search", input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify({ query: call.query }) } : { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function slotText(body: any, projection: any): string {
  const content = body.messages[projection.messageIndex].content;
  if (typeof content === "string") return content;
  const block = content[projection.contentBlockIndex];
  if (block.type === "text") return block.text;
  return typeof block.content === "string" ? block.content : block.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}

describe.each(["openai_compatible", "anthropic_messages"] as const)("serialized observation %s", protocol => {
  it("retains repeated ordinary projections and the real 16000-character synthesis with source locators", async () => {
    const snapshot: LlmRuntimeSnapshot = { id: "fixture", name: "fixture", provider: "custom", protocol, modelId: "fixture", baseUrl: "https://fixture.invalid/v1", contextWindow: 128000, apiKey: "local-fixture" };
    const events: ModelRequestObservation[] = [];
    const requests: any[] = [];
    const output = { query: "first", provider: "fixture", results: [{ title: "甲", url: "https://a.test/source", snippet: "中文原始材料🌱".repeat(3000), rank: 1 }, { title: "乙", url: "https://b.test/source", snippet: "第二份原始材料", rank: 2 }] };
    const sourceCatalog = "程序追加来源定位上下文：甲乙来源";
    const fullText = JSON.stringify({ capabilityContext: sourceCatalog, ...output });
    const registry = new ToolRegistry();
    registry.register({ identity: { name: "web_search", version: 1 }, label: "Search", description: "Fixture search", inputSchema: Type.Object({ query: Type.String() }), outputSchema: Type.Any(), effect: "network.read.public", timeoutMs: 1000, retry: { maxRetries: 0, backoffMs: 0 }, concurrency: 1, meter: { category: "search", countsBytes: false, countsTime: false }, model: { formatOutput: value => JSON.stringify(value) }, execute: async ({ query }) => query === "first" ? output : { ...output, query, results: [{ title: "乙", url: "https://b.test/source", snippet: "补充材料", rank: 1 }] } });
    const budget = new ToolBudgetLedger({ maxCalls: 20, categoryCalls: { search: 10, fetch: 10 } });
    const runner = new ToolRunner({ registry, policy: new ToolPolicy(), budget, audit: new FakeAuditSink(), clock: new FakeRetryClock() });
    const sessions = { createAgentTools: (context: any) => createPiAgentTools(registry, runner, { ...context, toolSet: new ToolSet([{ identity: { name: "web_search", version: 1 }, actor: "capability", effect: "network.read.public" }]) }), bindSearchProvider() {}, budgetSnapshot: () => budget.snapshot(), recordSynthetic: async () => undefined, releaseTrace: () => true };
    const gateway = new PiModelGateway();
    const runtime = defaultPiRuntime(gateway);
    const installedRuntime = { ...runtime, createSession: (snapshot: LlmRuntimeSnapshot, observer?: (event: ModelRequestObservation) => void) => {
      const session = runtime.createSession(snapshot, observer)!;
      return { ...session, streamFn: ((model: any, context: any, options: any) => session.streamFn(model, context, { ...options, fetch: async (_input: unknown, init: RequestInit) => {
        requests.push(JSON.parse(init.body as string));
        if (requests.length === 1) return completion(protocol, { id: "call_first", query: "first" });
        if (requests.length === 2) return completion(protocol, { id: "call_second", query: "second" });
        return completion(protocol);
      } })) as typeof session.streamFn };
    } };
    const capability = createCapabilityAgentRuntime({ runtime: installedRuntime, toolSessions: sessions, gateway });
    const agent = capability.createAgent({ observeModelRequest: event => events.push(event), toolOutputContext: () => sourceCatalog });
    const executionEvents: any[] = [];
    await agent.run({ requestId: "research_fixture", prompt: "研究此公司", systemPrompt: "请检索并用中文写报告", llm: snapshot, search: { id: "search", name: "search", provider: "zhipu", baseUrl: "https://fixture.invalid", apiKey: "local-search", options: { searchEngine: "search_std" } }, toolAccess: { network: "enabled", maxAgentTurns: 6, maxSearchCalls: 10, maxFetchCalls: 10 }, contextMessages: [] }, event => executionEvents.push(event), new AbortController().signal);
    expect(executionEvents.at(-1).type).toBe("completed");
    expect(requests[1].messages.find((message: any) => message.role === "tool")?.content ?? requests[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((block: any) => block.type === "tool_result")?.content).toContain("中文原始材料");
    expect(requests).toHaveLength(4);
    const dispatched = events.filter(event => event.state === "dispatched" && event.responseState === "pending");
    expect(dispatched.map(event => event.phase)).toEqual(["ordinary", "ordinary", "ordinary", "synthesis"]);
    expect(new Set(dispatched.map(event => event.modelRequestId)).size).toBe(4);
    const repeated = dispatched.slice(1, 3).map(event => event.projections.find(projection => projection.toolCallId === "call_first")!);
    expect(repeated.map(projection => projection.text)).toEqual([fullText, fullText]);
    expect(repeated[0]!.projectionId).not.toBe(repeated[1]!.projectionId);
    const synthesis = dispatched[3]!.projections.find(projection => projection.toolCallId === "call_first")!;
    expect(synthesis.text).toContain(fullText.slice(0, 16000).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, ""));
    expect(synthesis.text).toBe(`工具执行结果：\n${fullText.slice(0, 16000).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")}\n文本证据过长，已裁剪。\n来源 URL：https://a.test/source\nhttps://b.test/source`);
    expect(synthesis.sourceLocatorText).toBe("来源 URL：https://a.test/source\nhttps://b.test/source");
    expect(synthesis.text).toContain(synthesis.sourceLocatorText!);
    expect(synthesis.origin.sources.map(source => source.url)).toEqual(["https://a.test/source", "https://b.test/source"]);
    expect(synthesis.modelClipping!.beforeBytes).toBe(Buffer.byteLength(fullText, "utf8"));
    expect(synthesis.modelClipping!.afterBytes).toBe(Buffer.byteLength(fullText.slice(0, 16000), "utf8"));
    dispatched.forEach((event, requestIndex) => event.projections.forEach(projection => {
      expect(projection.mapping).toBe("mapped");
      expect(projection.text).toBe(slotText(requests[requestIndex], projection).slice(projection.start, projection.end));
      expect(projection.visibleBytes).toBe(Buffer.byteLength(projection.text, "utf8"));
      expect(projection.visibleHash).toBe(createHash("sha256").update(projection.text).digest("hex"));
    }));
  });
  it("observes the actual dispatched tool text and retains a failure receipt", async () => {
    const snapshot: LlmRuntimeSnapshot = { id: "fixture", name: "fixture", provider: "custom", protocol, modelId: "fixture", baseUrl: "https://fixture.invalid/v1", contextWindow: 128000, apiKey: "local-fixture" };
    const events: any[] = [];
    const requests: any[] = [];
    const text = JSON.stringify({ results: [{ title: "来源甲", url: "https://a.test", snippet: "中文依据🌱".repeat(3000) }, { title: "来源乙", url: "https://b.test", snippet: "第二来源" }] });
    const gateway = new PiModelGateway();
    const model = gateway.createModel(snapshot);
    const stream = gateway.createStream(snapshot, event => events.push(event));
    await stream(model, { messages: [
      { role: "user", content: "research", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "web_search", arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "call_1", toolName: "web_search", content: [{ type: "text", text }], isError: false, timestamp: 3 },
    ] }, { apiKey: "local-fixture", fetch: async (_input: unknown, init: RequestInit | undefined) => { requests.push(JSON.parse(init!.body as string)); return new Response("failure", { status: 503 }); }, requestObservation: { requestId: "research_1", phase: "ordinary", origins: [{ messageIndex: 2, toolCallId: "call_1", origin: { toolName: "web_search", sources: [{ url: "https://a.test", title: "来源甲" }, { url: "https://b.test", title: "来源乙" }] }, start: 0, end: text.length }] } } as any).result();
    expect(events.map(event => event.state)).toEqual(["prepared", "dispatched", "failed"]);
    const projection = events[1].projections[0];
    const messages = requests[0].messages;
    const toolBlock = messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).find((b: any) => b.type === "tool_result");
    const sent = protocol === "openai_compatible" ? messages.find((m: any) => m.role === "tool").content : typeof toolBlock.content === "string" ? toolBlock.content : toolBlock.content[0].text;
    expect(projection.text).toBe(sent);
    expect(projection.mapping).toBe("mapped");
    expect(projection.visibleBytes).toBe(Buffer.byteLength(sent, "utf8"));
    expect(projection.visibleHash).toBe(createHash("sha256").update(sent).digest("hex"));
    expect(new Set(events.map(event => event.modelRequestId)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain("local-fixture");
  });
});
