import { describe, expect, it } from "vitest";
import { HostClient } from "./host-client.js";
import { createUtilityAssembly } from "./assembly.js";
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
    ]);
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
