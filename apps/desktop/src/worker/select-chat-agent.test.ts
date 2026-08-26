import { describe, expect, it } from "vitest";
import { selectChatAgent, type ChatAgentFactories } from "./select-chat-agent.js";
import type { ChatAgent } from "./message-loop.js";

const fakeAgent: ChatAgent = { run: async () => {} };
const piAgent: ChatAgent = { run: async () => {} };

const factories: ChatAgentFactories = {
  fake: () => fakeAgent,
  pi: () => piAgent,
};

describe("chat agent selection", () => {
  it("selects the fake agent only for DEEPFIELD_AGENT_MODE=fake", () => {
    expect(selectChatAgent("fake", factories)).toBe(fakeAgent);
  });

  it("selects the production Pi agent for every other mode including undefined", () => {
    expect(selectChatAgent(undefined, factories)).toBe(piAgent);
    expect(selectChatAgent("", factories)).toBe(piAgent);
    expect(selectChatAgent("pi", factories)).toBe(piAgent);
    expect(selectChatAgent("anything-else", factories)).toBe(piAgent);
  });
});
