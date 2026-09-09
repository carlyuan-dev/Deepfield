import { describe, expect, it, vi } from "vitest";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import type { ChatAgent } from "./message-loop.js";
import { request } from "./pi-chat-agent-test-helpers.js";
import {
  createDeepSeekWebSearchAgent,
  routeWebSearchChatAgent,
} from "./deepseek-web-search-agent.js";

describe("DeepSeek web search agent", () => {
  it("forces web search and streams a link-bearing answer through the Chat event contract", async () => {
    const stream = [
      'event: response.created\ndata: {"type":"response.created","sequence_number":0}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":1,"delta":"近期进展 "}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","sequence_number":2,"delta":"https://example.com/source"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","sequence_number":3,"response":{"status":"completed"}}\n\n',
    ].join("");
    let capturedInit: RequestInit | undefined;
    const fetchFn = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const events: AgentWorkerEvent[] = [];

    const workerRequest = request({ webSearch: true });
    workerRequest.context.messages[1] = {
      role: "assistant",
      content: "本轮无法联网，请打开输入区的“联网”开关。",
      timestamp: 2,
    };

    await createDeepSeekWebSearchAgent({
      fetchFn,
      clock: () => new Date("2026-09-08T16:30:00.000Z"),
      timeZone: "Asia/Shanghai",
    }).run(
      workerRequest,
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(fetchFn).toHaveBeenCalledOnce();
    if (capturedInit === undefined) {
      throw new Error("expected request options");
    }
    const body = JSON.parse(String(capturedInit.body));
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toEqual({ type: "web_search" });
    expect(body.instructions).toContain("本轮已启用联网搜索");
    expect(body.instructions).toContain("当前日期：2026-09-09");
    expect(body.instructions).toContain("本机时区：Asia/Shanghai");
    expect(body.instructions).toContain("旧表述只适用于过去轮次");
    expect(body.instructions).toContain("官网、官方机构和其他可靠且可追责来源");
    expect(body.instructions).toContain("完整的 http/https 来源网址");
    expect(body.instructions).not.toContain("打开输入区的“联网”开关");
    expect(body.input).toEqual([
      { role: "user", content: "历史用户" },
      { role: "assistant", content: "本轮无法联网，请打开输入区的“联网”开关。" },
      { role: "user", content: "当前问题" },
    ]);
    expect(events).toEqual([
      { requestId: "req-1", type: "started", webSearch: true },
      {
        requestId: "req-1",
        type: "tool_activity",
        callKey: "web-search",
        name: "web_search",
        status: "running",
      },
      { requestId: "req-1", type: "text_delta", delta: "近期进展 " },
      { requestId: "req-1", type: "text_delta", delta: "https://example.com/source" },
      {
        requestId: "req-1",
        type: "tool_activity",
        callKey: "web-search",
        name: "web_search",
        status: "completed",
      },
      {
        requestId: "req-1",
        type: "completed",
        text: "近期进展 https://example.com/source",
      },
    ]);
  });

  it("emits a fixed failed web-search activity without query or provider details", async () => {
    const events: AgentWorkerEvent[] = [];
    const workerRequest = request({ webSearch: true });
    workerRequest.prompt = "private query sk-do-not-send";
    const agent = createDeepSeekWebSearchAgent({
      fetchFn: async () => {
        throw new Error("provider raw exception");
      },
    });

    await expect(
      agent.run(workerRequest, (event) => events.push(event), new AbortController().signal),
    ).rejects.toThrow("web search failed");

    expect(events).toEqual([
      { requestId: "req-1", type: "started", webSearch: true },
      {
        requestId: "req-1",
        type: "tool_activity",
        callKey: "web-search",
        name: "web_search",
        status: "running",
      },
      {
        requestId: "req-1",
        type: "tool_activity",
        callKey: "web-search",
        name: "web_search",
        status: "failed",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private query");
    expect(JSON.stringify(events)).not.toContain("provider raw exception");
  });

  it("routes every turn from that request's webSearch option", async () => {
    const calls: string[] = [];
    const fakeAgent = (name: string): ChatAgent => ({
      async run() {
        calls.push(name);
      },
    });
    const routed = routeWebSearchChatAgent(fakeAgent("plain"), fakeAgent("web"));

    await routed.run(
      request({ webSearch: false }),
      () => undefined,
      new AbortController().signal,
    );
    await routed.run(
      request({ webSearch: true }),
      () => undefined,
      new AbortController().signal,
    );

    expect(calls).toEqual(["plain", "web"]);
  });
});
