import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import type { ModelGateway } from "../../shared/model-gateway.js";
import { assistant, request, stubModel } from "../agent/pi-chat-agent-test-helpers.js";
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
});
