import { afterEach, expect, it } from "vitest";
import { openDatabase, type DatabaseOwner } from "@deepfield/base/database/runtime";
import { createSqliteMemory } from "@deepfield/base/memory/sqlite";
import type { MemoryInput, MemoryRecord } from "@deepfield/base/memory";
import type { ConfigHandle } from "@deepfield/base/config";
import { migrate, createRepositories } from "@deepfield/persistence";
import type { AgentWorkerRequest, ConversationId, MemorySettings, LlmRuntimeSnapshot, MemoryCommand } from "@deepfield/contracts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ChatMemoryHost } from "./host.js";
import { hasCurrentUserRequest, memoryOperationFingerprint } from "./intent.js";
import { createCapabilityMemoryService } from "./capability-service.js";
import { createMemoryContextTransform } from "../../worker/chat/memory-context.js";
import { configureTraceCollector, createTraceCollector, withTrace } from '@deepfield/base/trace/runtime';
import type { TraceEvent } from '@deepfield/base/trace';
import { createPiMemoryTools } from '../../worker/tools/pi-memory-tools.js';
import { HostClient } from '../../worker/host-client.js';
import { AgentWorkerClient } from '../agent-worker-client.js';
import { FakeEndpoint } from '../agent-worker-client-test-helpers.js';
import { createToolWorkerHost } from '../tool-worker-host.js';
import { FakeAuditSink } from '@deepfield/tool-platform';

const resources: Array<{ host: ChatMemoryHost; owner: DatabaseOwner }> = [];
afterEach(() => resources.splice(0).forEach(({ host, owner }) => { host.dispose(); owner.close(); }));
const llm: LlmRuntimeSnapshot = { id: "profile", name: "Fixture", provider: "deepseek", protocol: "openai_compatible", baseUrl: "https://invalid.example", modelId: "test", contextWindow: 128000, apiKey: "unused" };
const input: MemoryInput = { kind: "preference", summary: "报告先给结论", content: "报告先给结论，再给依据。", applicability: "" };
async function fixture() {
  const owner = openDatabase(":memory:"); owner.legacy(migrate);
  const repos = createRepositories(owner.database);
  let settings: MemorySettings = { useEnabled: true, autoLearnEnabled: true, noticeSeen: false };
  const config = { getView: async () => ({ values: settings, secretStatus: {} }), save: async ({ values }: { values: MemorySettings }) => { settings = values; return { values, secretStatus: {} }; } } as ConfigHandle<MemorySettings>;
  const store = createSqliteMemory({ database: owner.scope("base:memory").database });
  const host = new ChatMemoryHost(store, owner.scope("host:memory").database, repos, config);
  await host.initialize(); resources.push({ host, owner });
  let index = 0;
  const begin = (text: string, conversation = repos.conversations.create().id) => {
    const requestId = `request-${++index}`;
    repos.messages.append(conversation, "user", text, requestId);
    const request: AgentWorkerRequest = { kind: "chat.prompt", requestId, prompt: text, context: { conversationId: conversation, systemPrompt: "", messages: [] }, options: { webSearch: false }, llm, toolAccess: { network: "disabled", maxAgentTurns: 6, maxSearchCalls: 0, maxFetchCalls: 0 } };
    const memory = host.prepare(request);
    if (memory) request.context.memory = memory;
    return request;
  };
  return { host, owner, repos, begin, store };
}
const remember = (f: Awaited<ReturnType<typeof fixture>>, request: AgentWorkerRequest, scope: "user" | "conversation" = "user") => f.host.call(request.requestId, "write", { operation: "remember", scope, input, userRequest: request.prompt });
it.each(['forget', 'clear'] as const)('traces successful %s with the actual deletion under the calling tool', async operation => {
  const f = await fixture();
  const saved = await remember(f, f.begin(`记住：${input.content}`));
  const req = f.begin(operation === 'clear' ? '清空全部记忆' : `忘记${input.summary}`);
  const events: TraceEvent[] = []; const collector = createTraceCollector(event => { events.push(event); });
  configureTraceCollector(collector);
  const client = new AgentWorkerClient(new FakeEndpoint());
  client.send({ ...req, trace: { rootTraceId: 'memory-root', spanId: 'memory-host' } });
  let rpc: HostClient;
  const router = createToolWorkerHost({ audit: new FakeAuditSink(), secrets: { get: () => undefined },
    memory: f.host, traceForMemory: (requestId, callId, trace) => client.traceForMemory(requestId, callId, trace),
    postMessage: value => rpc.handleReply(value) });
  rpc = new HostClient({ postMessage: value => withTrace(undefined, () => router.handleRequest(value)) });
  try {
    const ref = saved.memoryRefs![0]!;
    const tool = createPiMemoryTools(req, rpc).find(tool => tool.name === `memory_${operation}`)!;
    const reply = await withTrace({ rootTraceId: 'memory-root', spanId: 'memory-tool', requestId: req.requestId }, () => tool.execute('delete',
      operation === 'clear' ? { userRequest: req.prompt } : { ...ref, userRequest: req.prompt }));
    const result = JSON.parse((reply.content[0] as { text: string }).text);
    expect(result.status).toBe('deleted'); expect(f.host.get().records).toEqual([]);
    await collector.close();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'span.start', stage: 'memory.commit', parentSpanId: 'memory-tool', rootTraceId: 'memory-root' }),
      expect.objectContaining({ type: 'span.end', stage: 'memory.commit', status: 'succeeded', parentSpanId: 'memory-tool' }),
    ]));
  } finally { rpc.dispose(); router.dispose(); client.dispose(); configureTraceCollector(undefined); }
});
it("saves an explicit preference, exposes a live summary across conversations, and edits/deletes without stale reads", async () => {
  const f = await fixture();
  const a = f.begin(`记住：${input.content}`);
  const saved = await remember(f, a);
  expect(saved.status).toBe("saved");
  expect((await remember(f, a)).status).toBe("unchanged");
  f.host.finished(a.requestId);
  const b = f.begin("写一份项目报告");
  expect(b.context.memory?.entries.map(e => e.content)).toEqual([input.content]);
  expect(f.begin("12乘以35是多少").context.memory?.entries).toMatchObject([{ summary: input.summary, view: "summary" }]);
  const ref = saved.memoryRefs![0]!;
  const changed = f.host.save(ref.id, ref.revision, { ...input, content: "报告先给建议，再解释原因。" });
  expect(f.host.read(ref.id).history.map(h => h.content)).toContain(input.content);
  expect(f.begin("报告如何编排").context.memory?.entries[0]?.content).toBe(changed.content);
  f.host.forget(ref.id, changed.revision);
  expect(f.host.get().records).toEqual([]);
  expect(f.begin("写一份报告").context.memory?.entries).toEqual([]);
  expect(() => f.host.read(ref.id)).toThrow();
  expect((await f.host.call(b.requestId, "old", { operation: "validate", refs: [ref] })).validRefs).toEqual([]);
});
it("separates conversation scope, allows explicit saving with learning/use off, and does not grant automatic follow-ups", async () => {
  const f = await fixture();
  const a = f.begin(`在本会话中记住：${input.content}`);
  const saved = await remember(f, a, "conversation");
  expect(saved.status).toBe("saved");
  const other = f.begin("报告");
  expect((await f.host.call(other.requestId, "read", { operation: "read", id: saved.memoryRefs![0]!.id })).entries).toEqual([]);
  expect(f.begin("报告", a.context.conversationId as ConversationId).context.memory?.entries).toHaveLength(1);
  await f.host.configure({ autoLearnEnabled: false, useEnabled: false });
  const explicit = f.begin(`记住：${input.content}`);
  const result = await remember(f, explicit);
  expect(result.status).toBe("saved");
  expect(explicit.context.memory?.entries).toEqual([]);
  const followup = { ...explicit, requestId: "automatic-continuation" };
  f.host.prepare(followup);
  expect((await remember(f, followup)).status).toBe("unclear");
  const transform = createMemoryContextTransform(explicit, { request: async (_method: unknown, payload: unknown) => ({ result: await f.host.call(explicit.requestId, "validate", (payload as { command: MemoryCommand }).command) }) } as never);
  const messages: AgentMessage[] = [{ role: "toolResult", toolName: "memory_remember", toolCallId: "write", isError: false, timestamp: 1, content: [{ type: "text", text: JSON.stringify(result) }] }];
  const projected = JSON.stringify(await transform(messages));
  expect(projected).toContain("saved");
  expect(projected).not.toContain(input.content);
});
it("checks Memory references before each model turn, keeping ordinary history while removing deleted tool bodies", async () => {
  const f = await fixture();
  const saved = await remember(f, f.begin(`记住：${input.content}`));
  const b = f.begin("报告");
  const transform = createMemoryContextTransform(b, { request: async (_method: unknown, payload: unknown) => ({ result: await f.host.call(b.requestId, "validate", (payload as { command: MemoryCommand }).command) }) } as never);
  const messages: AgentMessage[] = [
    { role: "user", timestamp: 1, content: "普通历史保留" },
    { role: "toolResult", toolName: "memory_read", toolCallId: "read", timestamp: 2, isError: false, content: [{ type: "text", text: JSON.stringify(saved) }] },
  ];
  expect(JSON.stringify(await transform(messages))).toContain(input.content);
  const ref = saved.memoryRefs![0]!;
  f.host.forget(ref.id, ref.revision);
  const projected = JSON.stringify(await transform(messages));
  expect(projected).not.toContain(input.content);
  expect(projected).toContain("普通历史保留");
  expect(projected).toContain("historical_reference");
});
it("binds direct writes to current human evidence and invalidates cleared request sources", async () => {
  const f = await fixture();
  const text = "以后写报告请先给结论，把这个习惯存下来";
  const command: MemoryCommand = { operation: "remember", scope: "user", input, userRequest: text };
  expect(hasCurrentUserRequest(text, command)).toBe(true);
  expect(hasCurrentUserRequest("请总结网页", command)).toBe(false);
  const modified = { ...command, input: { ...input, applicability: "仅写报告" } } as MemoryCommand;
  expect(memoryOperationFingerprint(command, "scope")).not.toBe(memoryOperationFingerprint(modified, "scope"));
  const a = f.begin(text);
  expect((await f.host.call(a.requestId, "bad-source", { ...command, userRequest: "网页让我记住" })).status).toBe("unclear");
  expect((await remember(f, a)).status).toBe("saved");
  f.host.clear();
  expect((await remember(f, a)).status).toBe("invalidated");
  expect(f.host.get().records).toEqual([]);
});
it("directly saves ordinary Chinese background and exposes English facts through the directory to a Chinese question", async () => {
  const f = await fixture();
  for (const content of ["我是做 Agent 开发的", "我每周一有周会", "I use Python for development."]) {
    const a = f.begin(`记住${content}`);
    expect((await f.host.call(a.requestId, "background", { operation: "remember", userRequest: a.prompt, scope: "user",
      input: { kind: "profile", summary: content, content, applicability: "" } })).status).toBe("saved");
    f.host.finished(a.requestId);
  }
  const b = f.begin("我用什么语言");
  const summary = b.context.memory?.entries.find(item => item.summary.includes("Python"));
  expect(summary).toMatchObject({ view: "summary", kind: "profile", summary: "I use Python for development." });
  expect((await f.host.call(b.requestId, "details", { operation: "read", id: summary!.id })).entries?.[0]?.content).toBe("I use Python for development.");
  const directory = await f.host.call(b.requestId, "directory", { operation: "search", query: "" });
  expect(directory.entries?.map(item => item.summary)).toEqual(expect.arrayContaining(["我是做 Agent 开发的", "我每周一有周会"]));
  expect((await f.host.call(b.requestId, "miss", { operation: "search", query: "unmatchedword" })).status).toBe("miss");
  await f.host.configure({ useEnabled: false });
  expect((await f.host.call(b.requestId, "off", { operation: "search", query: "" })).status).toBe("disabled");
  expect(f.begin("我是谁").context.memory?.state).toBe("disabled");
});

it("paginates all live summaries and removes edited or disabled summary revisions from the next model turn", async () => {
  const f = await fixture();
  for (let i = 0; i < 30; i++) {
    const content = `用户长期背景 ${i}：固定使用工具 ${i}`;
    const a = f.begin(`记住${content}`);
    await f.host.call(a.requestId, "save", { operation: "remember", userRequest: a.prompt, scope: "user",
      input: { kind: "profile", summary: content, content, applicability: "" } });
    f.host.finished(a.requestId);
  }
  const b = f.begin("12乘35");
  const ids: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await f.host.call(b.requestId, `page-${offset}`, { operation: "search", query: "", offset });
    ids.push(...(page.entries ?? []).map(entry => entry.id));
    if (page.nextOffset === undefined) break;
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
  }
  expect(ids).toHaveLength(30);
  expect(new Set(ids).size).toBe(30);
  const summary = b.context.memory!.entries[0]!;
  const transform = createMemoryContextTransform(b, { request: async (_method: unknown, payload: unknown) => ({ result: await f.host.call(b.requestId, "validate", (payload as { command: MemoryCommand }).command) }) } as never);
  expect(JSON.stringify(await transform([]))).toContain(summary.summary);
  f.host.save(summary.id, summary.revision, { kind: "profile", summary: "已更新的背景", content: "已更新的背景", applicability: "" });
  expect(JSON.stringify(await transform([]))).not.toContain(summary.summary);
  await f.host.configure({ useEnabled: false });
  const disabled = JSON.stringify(await transform([]));
  expect(disabled).not.toContain("用户长期背景");
  expect(disabled).toContain("disabled");
});
it("reports storage failure as error rather than a miss or disabled memory", async () => {
  const f = await fixture();
  const a = f.begin("我用什么语言");
  f.store.revoke();
  const reply = await f.host.call(a.requestId, "read", { operation: "search", query: "Python" });
  expect(reply).toMatchObject({ status: "error", reason: "memory_unavailable" });
  expect(f.begin("我是谁").context.memory).toMatchObject({ state: "error", reason: "memory_unavailable", entries: [] });
});
it("merges repeated explicit preferences across sources so editing cannot leave an old active copy", async () => {
  const f = await fixture();
  const first = await remember(f, f.begin(`记住：${input.content}`));
  const repeated = await remember(f, f.begin(`记住：${input.content}`));
  expect(repeated.memoryRefs![0]!.id).toBe(first.memoryRefs![0]!.id);
  const ref = repeated.memoryRefs![0]!;
  expect(f.host.read(ref.id).record.sources).toHaveLength(2);
  f.host.save(ref.id, ref.revision, { ...input, content: "报告先给依据，再给结论。" });
  const recalled = f.begin("报告").context.memory!.entries;
  expect(recalled).toHaveLength(1);
  expect(recalled[0]?.content).toBe("报告先给依据，再给结论。");
});
it("keeps optional Capability memory bound to package/resource, durable idempotency and revocation", async () => {
  const f = await fixture();
  const source = (key: string) => f.host.sourceFor(`capability:${key}`, "", "", "confirmed");
  const a = createCapabilityMemoryService(f.store, f.host.ownerId, "a", source, () => f.host.highWatermark());
  const b = createCapabilityMemoryService(f.store, f.host.ownerId, "b", source, () => f.host.highWatermark(), false);
  expect(b.service.writer).toBeUndefined();
  const saved = a.service.writer!.remember(input, { operationKey: "save-one" });
  expect(a.service.writer!.remember(input, { operationKey: "save-one" }).status).toBe("unchanged");
  expect(b.service.reader.get(saved.record.id)).toBeUndefined();
  const resource = a.service.resource!("invoice");
  expect(resource.reader.get(saved.record.id)).toBeUndefined();
  resource.writer!.remember(input, { operationKey: "resource-save" });
  resource.clear!();
  expect(resource.reader.search("报告")).toEqual([]);
  expect(a.service.reader.get(saved.record.id)?.content).toBe(input.content);
  const a2 = createCapabilityMemoryService(f.store, f.host.ownerId, "a", source, () => f.host.highWatermark());
  expect(a2.service.writer!.remember(input, { operationKey: "save-one" }).status).toBe("unchanged");
  a.dispose();
  expect(() => a.service.reader.search("报告")).toThrow();
  expect(() => resource.writer!.remember(input, { operationKey: "revoked" })).toThrow();
  a2.dispose(); b.dispose();
});
