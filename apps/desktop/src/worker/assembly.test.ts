import { describe, expect, it } from "vitest";
import { HostClient } from "./host-client.js";
import { createUtilityAssembly } from "./assembly.js";
import { CompanyResearchWorkerEventSchema, StructuredResearchContentSchema, RESEARCH_DIRECTIONS, getCompanyResearchTemplate, type CompanyResearchWorkerEvent } from "@deepfield/contracts";
import { Value } from "typebox/value";
import { rawResearchRequest, structureResearchRequest } from "./company-research-test-helpers.js";
import {
  FakePiAgent,
  makeRuntime,
  request,
  stubModel,
} from "./pi-chat-agent-test-helpers.js";
import {
  flushPending,
  InMemoryEndpoint,
} from "./message-loop-test-helpers.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

describe("utility worker assembly (focused revision)", () => {
  it.each(RESEARCH_DIRECTIONS)("fake research completes both stages for %s without structure deltas", async (direction) => {
    const endpoint = new InMemoryEndpoint();
    const hostClient = new HostClient({ postMessage: () => {}, timeoutMs: 1000 });
    const { loop } = createUtilityAssembly({ endpoint, agentMode: "fake", hostClient });
    const template = getCompanyResearchTemplate(direction);
    const raw = { ...rawResearchRequest(), context: { ...rawResearchRequest().context, direction }, template };
    endpoint.emit(raw);
    await flushPending();
    const rawEvents = endpoint.posted as CompanyResearchWorkerEvent[];
    expect(rawEvents.map((event) => event.type)).toEqual(["started", "text_delta", "completed"]);
    const terminal = rawEvents.at(-1);
    if (terminal?.type !== "completed") throw new Error("raw did not complete");
    for (const section of template.sections) expect(terminal.text).toContain(section.sectionId);
    const rawReportText = terminal.text;
    endpoint.posted = [];
    endpoint.emit({ ...structureResearchRequest(), context: raw.context, template, rawReportText });
    await flushPending();
    const events = endpoint.posted as CompanyResearchWorkerEvent[];
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
      events: [{ type: "agent_start" } as AgentEvent, { type: "agent_end", messages: [] }],
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
      "check_link_accessibility",
      "web_search",
    ]);
    loop.dispose();
  });

  it("exposes network tools only for a web-enabled request", async () => {
    const agent = new FakePiAgent({ events: [{ type: "agent_start" } as AgentEvent, { type: "agent_end", messages: [] }] });
    const endpoint = new InMemoryEndpoint();
    const hostClient = { request: () => Promise.resolve({ acknowledged: true }), handleReply: () => undefined, dispose: () => undefined } as unknown as HostClient;
    const { loop, toolRuntime } = createUtilityAssembly({ endpoint, agentMode: "pi", hostClient, piRuntime: makeRuntime(agent, stubModel) });
    endpoint.emit(request({ webSearch: true })); await flushPending();
    const names = (agent.receivedOptions?.initialState?.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["web_search", "fetch_url", "calculator"]));
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
