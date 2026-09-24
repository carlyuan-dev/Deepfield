import { describe, expect, it } from "vitest";
import { HostClient } from "./host-client.js";
import { createUtilityAssembly } from "./assembly.js";
import { activate as activateCompanyResearch } from "../../../../capabilities/company-research/worker.js";
import { createCapabilityAgentRuntime } from "./capabilities/agent-runtime.js";
import { withUsageContext } from "../shared/usage-collection.js";
import { CompanyResearchWorkerEventSchema, StructuredResearchContentSchema, RESEARCH_DIRECTIONS, getCompanyResearchTemplate, type CompanyResearchWorkerEvent } from "../../../../capabilities/company-research/contracts/index.js";
import { Value } from "typebox/value";
import { renderChatHelp } from "@deepfield/application";
import { availableChatTools } from "./tools/tool-runtime.js";
import { rawResearchRequest, structureResearchRequest } from "../../../../capabilities/company-research/runtime/company-research-test-helpers.js";
import {
  assistant,
  FakePiAgent,
  makeRuntime,
  request,
  stubModel,
} from "./agent/pi-chat-agent-test-helpers.js";
import {
  flushPending,
  InMemoryEndpoint,
} from "./message-loop-test-helpers.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

describe("utility worker assembly (focused revision)", () => {
  it.each(RESEARCH_DIRECTIONS)("fake research completes both stages for %s without structure deltas", async (direction) => {
    const endpoint = new InMemoryEndpoint();
    const hostClient = new HostClient({ postMessage: () => {}, timeoutMs: 1000 });
    const { loop } = createUtilityAssembly({ endpoint, agentMode: "fake", hostClient,
      capabilityLoader: async (_request, registrar) => activateCompanyResearch(registrar, { runtime: createCapabilityAgentRuntime(), mode: "fake", withUsage: withUsageContext }),
    });
    endpoint.emit({ kind: "capability.activate", capabilityId: "company-research", requestId: "activate", entry: "builtin:company-research" });
    await flushPending();
    expect(endpoint.posted).toEqual([{ kind: "capability.activated", capabilityId: "company-research", requestId: "activate", ok: true }]);
    endpoint.posted = [];
    const template = getCompanyResearchTemplate(direction);
    const raw = { ...rawResearchRequest(), context: { ...rawResearchRequest().context, direction }, template };
    endpoint.emit({ kind: "capability.run", capabilityId: "company-research", operation: "research", requestId: raw.requestId, input: raw });
    await flushPending();
    const rawEvents = endpoint.posted.map(value => (value as { payload: CompanyResearchWorkerEvent }).payload);
    expect(rawEvents.map((event) => event.type)).toEqual(["started", "text_delta", "completed"]);
    const terminal = rawEvents.at(-1);
    if (terminal?.type !== "completed") throw new Error("raw did not complete");
    for (const section of template.sections) expect(terminal.text).toContain(section.sectionId);
    const rawReportText = terminal.text;
    endpoint.posted = [];
    endpoint.emit({ kind: "capability.run", capabilityId: "company-research", operation: "research", requestId: structureResearchRequest().requestId, input: { ...structureResearchRequest(), context: raw.context, template, rawReportText } });
    await flushPending();
    const events = endpoint.posted.map(value => (value as { payload: CompanyResearchWorkerEvent }).payload);
    expect(events.map((event) => event.type)).toEqual(["started", "completed"]);
    expect(events.every((event) => Value.Check(CompanyResearchWorkerEventSchema, event))).toBe(true);
    const structured = events.at(-1);
    if (structured?.type !== "completed") throw new Error("structure did not complete");
    const content = JSON.parse(structured.text);
    expect(Value.Check(StructuredResearchContentSchema, content)).toBe(true);
    expect(content.sections.map((section: { sectionId: string }) => section.sectionId)).toEqual(template.sections.map((section) => section.sectionId));
    expect(content.coreSummary).toEqual(["现有公开信息不足以形成可靠的核心判断。"]);
    expect(content.sections.every((section: { status: string; summary: unknown; facts: unknown[] }) => section.status === "not_found" && section.summary === null && section.facts.length === 0)).toBe(true);
    loop.dispose();
  });

  it("exposes per-request utility tools and releases the request trace", async () => {
    let agent!: FakePiAgent;
    agent = new FakePiAgent({
      beforeEvents: async () => {
        const tools = (agent.receivedOptions?.initialState as { tools?: Array<{ name: string; execute: Function }> }).tools ?? [];
        const calculator = tools.find((tool) => tool.name === "calculator");
        if (calculator === undefined) {
          throw new Error("calculator tool was not exposed");
        }
        await calculator.execute(
          "call-1",
          { expression: "6 * 7" },
          new AbortController().signal,
          () => undefined,
        );
      },
      events: [{ type: "agent_start" } as AgentEvent, { type: "agent_end", messages: [assistant("完成")] }],
    });
    const endpoint = new InMemoryEndpoint();
    const hostClient = {
      request: () => Promise.resolve({ acknowledged: true }),
      handleReply: () => undefined,
      dispose: () => undefined,
    } as unknown as HostClient;
    const { loop, toolRuntime } = createUtilityAssembly({
      endpoint,
      agentMode: "pi",
      hostClient,
      piRuntime: makeRuntime(agent, stubModel),
    });
    endpoint.emit(request());
    await flushPending();
    expect(
      (agent.receivedOptions?.initialState as { tools?: Array<{ name: string }> }).tools?.map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "view_available_features",
      "get_current_datetime",
      "calculator",
      "convert_timezone",
      "list_conversations",
      "read_conversation",
      "search_conversations",
    ]);
    const visibleNames = (
      (agent.receivedOptions?.initialState as { tools?: Array<{ name: string }> }).tools ?? []
    ).map((tool) => tool.name);
    expect(visibleNames).not.toEqual(
      expect.arrayContaining([
        "fetch_url",
        "fetch_pdf",
        "parse_html",
        "parse_pdf",
        "check_link_accessibility",
      ]),
    );
    expect(toolRuntime.traceLedgerCount()).toBe(0);
    expect(endpoint.posted.some((value) => (value as { type?: string }).type === "completed")).toBe(
      true,
    );
    loop.dispose();
  });

  it("injects a read-only feature tool even without capabilities and returns the help template", async () => {
    const outputs: string[] = [];
    let agent!: FakePiAgent;
    agent = new FakePiAgent({ beforeEvents: async () => {
      const tools = (agent.receivedOptions?.initialState as { tools?: Array<{ name: string; execute: Function }> }).tools ?? [];
      const feature = tools.find(tool => tool.name === "view_available_features");
      if (!feature) throw new Error("feature tool was not injected");
      const result = await feature.execute("features", {}, new AbortController().signal);
      outputs.push(result.content[0].text);
    }, events: [{ type: "agent_start" } as AgentEvent, { type: "agent_end", messages: [assistant("完成")] }] });
    const endpoint = new InMemoryEndpoint();
    const hostClient = { request: () => Promise.resolve({ acknowledged: true }), handleReply: () => undefined, dispose: () => undefined } as unknown as HostClient;
    const { loop } = createUtilityAssembly({ endpoint, agentMode: "pi", hostClient, piRuntime: makeRuntime(agent, stubModel) });
    endpoint.emit({ ...request(), prompt: "我们有哪些工具可以用？" });
    await flushPending();
    expect(outputs[0]).toBe(renderChatHelp(availableChatTools(false), []));
    expect(outputs[0]).toContain("当前没有可用能力");
    expect(outputs[0]).not.toContain("网页搜索");
    const ready = [{ name: "示例能力", markdown: "整理事项。\n\n例如：新建一个事项" }];
    endpoint.emit({ ...request(), requestId: "req-2", prompt: "我们有什么能力？",
      context: { ...request().context, capabilityHelp: ready } });
    await flushPending();
    expect(outputs[1]).toBe(renderChatHelp(availableChatTools(false), ready));
    expect(outputs[1]).toContain("### 示例能力\n\n整理事项。\n\n例如：新建一个事项");
    expect(outputs[1]).not.toContain("sha256");
    loop.dispose();
  });

  it("registers utility tools but not probe tools in production by default", () => {
    const endpoint = new InMemoryEndpoint();
    const hostClient = new HostClient({ postMessage: () => {}, timeoutMs: 1000 });
    const { loop, toolRuntime } = createUtilityAssembly({
      endpoint,
      agentMode: "pi",
      hostClient,
    });
    expect(toolRuntime.registry.list().map((definition) => definition.identity.name)).toEqual([
      "get_current_datetime",
      "calculator",
      "convert_timezone",
      "list_conversations",
      "read_conversation",
      "search_conversations",
      "fetch_url",
      "fetch_pdf",
      "parse_html",
      "parse_pdf",
      "read_webpage",
      "check_link_accessibility",
      "web_search",
    ]);
    loop.dispose();
  });

  it("exposes network tools only for a web-enabled request", async () => {
    const agent = new FakePiAgent({ events: [{ type: "agent_start" } as AgentEvent, { type: "agent_end", messages: [assistant("完成")] }] });
    const endpoint = new InMemoryEndpoint();
    const hostClient = { request: () => Promise.resolve({ acknowledged: true }), handleReply: () => undefined, dispose: () => undefined } as unknown as HostClient;
    const { loop, toolRuntime } = createUtilityAssembly({ endpoint, agentMode: "pi", hostClient, piRuntime: makeRuntime(agent, stubModel) });
    endpoint.emit(request({ webSearch: true })); await flushPending();
    const names = (agent.receivedOptions?.initialState?.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["web_search", "read_webpage", "calculator"]));
    expect(names).not.toContain("fetch_url");
    expect(toolRuntime.searchSessions.has("req-1")).toBe(false);
    loop.dispose();
  });

  it("disposing the loop also disposes the host client", () => {
    const endpoint = new InMemoryEndpoint();
    let disposed = false;
    const hostClient = {
      handleReply: () => {},
      dispose: () => {
        disposed = true;
      },
      request: () => Promise.resolve({ acknowledged: true }),
    } as unknown as HostClient;
    const { loop } = createUtilityAssembly({ endpoint, agentMode: "pi", hostClient });
    loop.dispose();
    expect(disposed).toBe(true);
  });
});
