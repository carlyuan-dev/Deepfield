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
  it("keeps the default Pi agent tools empty in the production assembly", async () => {
    const agent = new FakePiAgent({
      events: [{ type: "agent_start" } as AgentEvent, { type: "agent_end", messages: [] }],
    });
    const endpoint = new InMemoryEndpoint();
    const hostClient = new HostClient({ postMessage: () => {}, timeoutMs: 1000 });
    const { loop } = createUtilityAssembly({
      endpoint,
      agentMode: "pi",
      hostClient,
      piRuntime: makeRuntime(agent, stubModel),
    });
    endpoint.emit(request());
    await flushPending();
    expect((agent.receivedOptions?.initialState as { tools?: unknown[] }).tools).toEqual([]);
    expect(endpoint.posted.some((value) => (value as { type?: string }).type === "completed")).toBe(
      true,
    );
    loop.dispose();
  });

  it("does not register probe tools in the production assembly by default", () => {
    const endpoint = new InMemoryEndpoint();
    const hostClient = new HostClient({ postMessage: () => {}, timeoutMs: 1000 });
    const { loop, toolRuntime } = createUtilityAssembly({
      endpoint,
      agentMode: "pi",
      hostClient,
    });
    expect(toolRuntime.registry.list()).toHaveLength(0);
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
