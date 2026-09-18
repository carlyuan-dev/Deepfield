import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolBudgetSnapshot } from "@deepfield/tool-platform";
import { describe, expect, it, vi } from "vitest";
import { createPiAgentExecutor } from "./pi-agent-executor.js";
import {
  agentEnd,
  assistant,
  FakePiAgent,
  makeRuntime,
  request,
  stubModel,
} from "./pi-chat-agent-test-helpers.js";

describe("Pi agent executor context boundary", () => {
  it("uses an injected context without a Chat adapter", async () => {
    const answer = assistant("好的");
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        { type: "message_end", message: answer },
        agentEnd([answer]),
      ],
    });
    const injectedMessages = [{ role: "user" as const, content: "injected history", timestamp: 10 }];
    const ended: AgentMessage[] = [];
    const prepareContext = vi.fn((_request, model) => {
      expect(model).toBe(stubModel);
      return {
        messages: injectedMessages,
        basePromptParts: ["context base prompt", ""],
        finalizationPromptParts: ["context finalization prompt"],
        sessionId: "injected-session",
        onMessageEnd: (message: AgentMessage) => ended.push(message),
      };
    });

    await createPiAgentExecutor(
      prepareContext,
      makeRuntime(fake, stubModel),
    ).run(request(), () => undefined, new AbortController().signal);

    expect(prepareContext).toHaveBeenCalledOnce();
    expect(fake.receivedOptions?.initialState?.messages).toEqual(injectedMessages);
    expect(fake.receivedOptions?.initialState?.systemPrompt).toContain("context base prompt\n");
    expect(fake.receivedOptions?.sessionId).toBe("injected-session");
    expect(ended).toEqual([answer]);
  });

  it("uses injected finalization prompt parts for Capability synthesis", async () => {
    const answer = assistant("最终答案");
    const fake = new FakePiAgent({
      events: [
        { type: "agent_start" },
        { type: "message_end", message: answer },
        agentEnd([answer]),
      ],
    });
    const emptyBudget: ToolBudgetSnapshot = {
      total: { limit: 0, reserved: 0, consumed: 0, remaining: 0, exhausted: true },
      categories: {
        search: { limit: 0, reserved: 0, consumed: 0, remaining: 0, exhausted: true },
        fetch: { limit: 0, reserved: 0, consumed: 0, remaining: 0, exhausted: true },
        link_check: { reserved: 0, consumed: 0, exhausted: false },
        parse: { reserved: 0, consumed: 0, exhausted: false },
        none: { reserved: 0, consumed: 0, exhausted: false },
      },
    };
    const toolSessions = {
      createAgentTools: () => [],
      bindSearchProvider: () => undefined,
      budgetSnapshot: () => emptyBudget,
      recordSynthetic: async () => undefined,
      releaseTrace: () => true,
    };
    const workerRequest = request({ webSearch: true });
    workerRequest.context.finalizationSystemPrompt = "structured output only";
    workerRequest.toolAccess = {
      network: "enabled",
      maxAgentTurns: 1,
      maxSearchCalls: 0,
      maxFetchCalls: 0,
    };

    await createPiAgentExecutor(
      () => ({
        messages: [],
        basePromptParts: ["context base prompt"],
        finalizationPromptParts: ["context finalization prompt"],
        sessionId: "capability-session",
      }),
      makeRuntime(fake, stubModel),
      [],
      undefined,
      {},
      toolSessions,
      undefined,
      undefined,
      "capability",
    ).run(workerRequest, () => undefined, new AbortController().signal);

    expect(fake.receivedOptions?.initialState?.systemPrompt).toContain("structured output only");
    expect(fake.receivedOptions?.initialState?.systemPrompt).toContain("context finalization prompt");
    expect(fake.receivedOptions?.initialState?.systemPrompt).not.toContain("context base prompt");
  });
});
