import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import type { ModelGateway } from "../../shared/model-gateway.js";
import { assistant, request, stubModel, makeRecordingInstalledPiRuntime } from "../agent/pi-chat-agent-test-helpers.js";
import { createMemoryDependencyTransform, messageMemoryDependencies, tagMemoryDependencies } from "./memory-dependencies.js";
import type { HostClient } from "../host-client.js";
import { createPiChatAgent } from "../agent/pi-chat-agent.js";
import { compactTokens, createCompactContextTransform } from "./compact-context.js";

function setup(fail = false) {
  const events: AgentWorkerEvent[] = [];
  const summarize = vi.fn(async () => {
    if (fail) throw new Error("offline");
    return assistant("目标：完成Alpha；已完成：文件已创建，不要重复创建。待办：核验结果。");
  });
  const gateway = { getApiKey: async () => "fake", createStream: () => () => ({ result: summarize }) } as unknown as ModelGateway;
  const input = request();
  input.prompt = "继续核验Alpha";
  input.llm.contextWindow = 16384;
  const model = { ...stubModel, contextWindow: 16384, maxTokens: 1024 };
  return { events, summarize, input, model, gateway };
}
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });

describe("conversation compaction", () => {
  it("sends the compacted facts intact to the actual Pi model boundary before answering", async () => {
    const s = setup();
    const summary = "最终预算18万元，12家门店，2026-12-01开始。培训通知已发送，合同未签。只整理清单，不执行外部操作。";
    s.summarize.mockResolvedValue(assistant(summary));
    const recorded = makeRecordingInstalledPiRuntime([assistant("交接清单")]);
    const createSession = recorded.runtime.createSession;
    recorded.runtime.createSession = (...args) => {
      const session = createSession(...args);
      if (!session) throw new Error("test session unavailable");
      return { ...session, model: { ...session.model!, maxTokens: 1024 } };
    };
    s.input.context.messages = Array.from({ length: 10 }, (_, i) => ({ role: "user" as const, content: "旧背景" + String(i) + "已过时的材料。".repeat(1000), timestamp: i }));
    const agent = createPiChatAgent(recorded.runtime, [], undefined, {}, undefined, s.gateway);
    await agent.run(s.input, e => s.events.push(e), new AbortController().signal);
    expect(s.events.some(e => e.type === "context_compacted")).toBe(true);
    expect(recorded.requests).toHaveLength(1);
    const content = JSON.stringify(recorded.requests[0]!.messages);
    expect(content).toContain(summary);
    expect(content).toContain(s.input.prompt);
    expect(content).not.toContain("旧背景0");
    expect(content.length).toBeLessThan(JSON.stringify(s.input.context.messages).length / 2);
  });

  it("continues past an oversized completed turn while retaining the current task and original history", async () => {
    const s = setup();
    s.input.llm.contextWindow = 32768;
    s.model.contextWindow = 32768;
    s.model.maxTokens = 4096;
    const oldMaterial = user("已处理的临时清单：" + "CHECK: imported; no action.\n".repeat(1400));
    const history = [user("Alpha文件已创建；接下来只核验结果，不要重复创建。"), assistant("收到。"), oldMaterial, assistant("已收到临时清单")];
    const hostContext = assistant("宿主上下文数据：" + "能力目录说明".repeat(780));
    const raw = [...history, hostContext, user(s.input.prompt)];
    const original = structuredClone(raw);
    const framing = { systemPrompt: "系统约束".repeat(2500), tools: [] };
    const transform = createCompactContextTransform(s.input, history.length, s.model, s.gateway, e => s.events.push(e));

    const result = await transform(raw, undefined, framing);

    expect(result.some(m => m.role === "compactionSummary" && m.summary.includes("不要重复创建"))).toBe(true);
    expect(result).toContainEqual(user(s.input.prompt));
    expect(result).not.toContainEqual(oldMaterial);
    const hardBudget = 32768 - 4096 - 2048 - Math.ceil(JSON.stringify(framing).length / 2) - 1024;
    expect(compactTokens(result)).toBeLessThan(hardBudget);
    expect(raw).toEqual(original);
    expect(s.summarize).toHaveBeenCalledTimes(1);
  });

  it("summarizes old work, retains current input and complete tool receipts, and reuses the projection", async () => {
    const s = setup();
    const history: AgentMessage[] = Array.from({ length: 10 }, (_, i) => user(`旧任务${i}：${"详细说明".repeat(600)}`));
    const call = assistant("", { stopReason: "toolUse" });
    call.content = [{ type: "toolCall", id: "create-once", name: "write", arguments: { path: "Alpha" } }];
    // Larger than Pi's preferred recent tail, but the whole batch fits the window.
    const receipt: AgentMessage = { role: "toolResult", toolCallId: "create-once", toolName: "write", isError: false, content: [{ type: "text", text: "文件已创建；".repeat(900) }], timestamp: 1 };
    const raw = [...history, user(s.input.prompt), call, receipt];
    const transform = createCompactContextTransform(s.input, history.length, s.model, s.gateway, e => s.events.push(e));
    const result = await transform(raw);
    expect(result.some(m => m.role === "compactionSummary" && m.summary.includes("不要重复创建"))).toBe(true);
    expect(result.some(m => m.role === "user" && m.content === s.input.prompt)).toBe(true);
    expect(result.some(m => m.role === "assistant" && m.content.some(p => p.type === "toolCall" && p.id === "create-once"))).toBe(true);
    expect(result).toContainEqual(receipt);
    const calls = s.summarize.mock.calls.length;
    await transform([...raw, assistant("核验完成")]);
    expect(s.summarize).toHaveBeenCalledTimes(calls);
    const checkpoints = s.events.filter(e => e.type === "context_compacted");
    expect(checkpoints.at(-1)?.compaction.sourceMessageCount).toBe(3);
    expect(raw).toHaveLength(13);
  });

  it("keeps original history and publishes no checkpoint when summarization fails", async () => {
    const s = setup(true);
    const history = Array.from({ length: 10 }, () => user("既有任务".repeat(600)));
    const raw = [...history, user(s.input.prompt)];
    const before = structuredClone(raw);
    const transform = createCompactContextTransform(s.input, history.length, s.model, s.gateway, e => s.events.push(e));
    await expect(transform(raw)).rejects.toThrow("offline");
    expect(raw).toEqual(before);
    expect(s.events.some(e => e.type === "context_compacted")).toBe(false);
    expect(s.summarize).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before issuing a summary and does not summarize short chat automatically", async () => {
    const s = setup();
    const transform = createCompactContextTransform(s.input, 0, s.model, s.gateway, e => s.events.push(e));
    const short = [user("你好")];
    expect(await transform(short)).toEqual(short);
    const controller = new AbortController(); controller.abort();
    await expect(transform(Array.from({ length: 10 }, () => user("长上下文".repeat(600))), controller.signal)).rejects.toThrow();
    expect(s.summarize).not.toHaveBeenCalled();
  });
  it("revalidates Memory-derived cached compaction and never resummarizes expired content", async () => {
    const s = setup(); const secret = "EXPIRED-MEMORY-SUMMARY"; let enabled = true;
    const summaryInputs: string[] = [];
    s.gateway = { getApiKey: async () => "fake", createStream: () => (_model: unknown, context: unknown) => ({ result: async () => {
      summaryInputs.push(JSON.stringify(context)); return assistant(summaryInputs.length === 1 ? secret : "只保留当前有效任务。");
    } }) } as unknown as ModelGateway;
    const host: Pick<HostClient,"request"> = { request: async (_method, payload) => ({ result: { status: "ok", useEnabled: enabled, validRefs: enabled ? (payload as {command:{refs:unknown[]}}).command.refs : [] } }) };
    const refs = [{id:"memory-1",revision:1}];
    const history = Array.from({length:10}, () => tagMemoryDependencies(user(secret + "旧材料".repeat(1000)), refs));
    const raw = [...history,user(s.input.prompt)];
    const transform = createCompactContextTransform(s.input,history.length,s.model,s.gateway,event=>s.events.push(event),createMemoryDependencyTransform(s.input.requestId,host));
    const first = await transform(raw);
    expect(first.some(message=>message.role === "compactionSummary" && message.summary.includes(secret))).toBe(true);
    enabled = false;
    const next = await transform([...raw,...Array.from({length:10},()=>user("新的独立资料".repeat(600))),user("继续当前有效工作")]);
    expect(summaryInputs.length).toBeGreaterThan(1);
    for (const input of summaryInputs.slice(1)) expect(input).not.toContain(secret);
    expect(JSON.stringify(next)).not.toContain(secret);
    // Redacted history must not taint a new independent summary/task with revoked refs.
    expect(next.flatMap(message => messageMemoryDependencies(message))).toEqual([]);
    expect(raw.flatMap(message => messageMemoryDependencies(message)).length).toBeGreaterThan(0);
  });

});
