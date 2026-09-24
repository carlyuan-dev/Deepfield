import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AgentWorkerEventSchema } from "@deepfield/contracts";
import { describe, expect, it, vi } from "vitest";
import { createExecutionHandoff } from "./execution-handoff.js";
import { createPiAgentExecutor } from "./pi-agent-executor.js";
import type { PiExecutionEvent, PiExecutionRequest } from "./pi-execution-contract.js";
import { assistant, makeRecordingInstalledPiRuntime, request } from "./pi-chat-agent-test-helpers.js";
import { createWorkerMessageLoop, type ChatAgent } from "../message-loop.js";
import { flushPending, InMemoryEndpoint } from "../message-loop-test-helpers.js";
import { isChatTerminal } from "../../main/agent-worker-protocol.js";

function executionRequest(maxAgentTurns = 6): PiExecutionRequest {
  const workerRequest = request();
  return {
    requestId: workerRequest.requestId,
    prompt: workerRequest.prompt,
    systemPrompt: workerRequest.context.systemPrompt,
    contextMessages: workerRequest.context.messages,
    llm: workerRequest.llm,
    toolAccess: { network: "disabled", maxAgentTurns, maxSearchCalls: 0, maxFetchCalls: 0 },
  };
}

function tool(name: string, execute: AgentTool<any>["execute"]): AgentTool<any> {
  return { name, label: name, description: name, parameters: Type.Object({}), execute };
}

function toolTurn(ids: string[]) {
  return assistant("", {
    content: ids.map((id) => ({ type: "toolCall" as const, id, name: id, arguments: {} })),
    stopReason: "toolUse",
  });
}

function setup(responses: ReturnType<typeof assistant>[]) {
  const recording = makeRecordingInstalledPiRuntime(responses);
  const messages: AgentMessage[] = [];
  return {
    ...recording,
    messages,
    runtime: {
      ...recording.runtime,
      createAgent(options: ConstructorParameters<typeof Agent>[0]) {
        const agent = new Agent(options);
        agent.subscribe((event) => {
          if (event.type === "agent_end") messages.push(...event.messages);
        });
        return agent;
      },
    },
  };
}

async function run(
  runtime: ReturnType<typeof setup>["runtime"],
  tools: AgentTool<any>[],
  handoff?: { request(): void; isRequested(): boolean },
  maxAgentTurns = 6,
) {
  const events: PiExecutionEvent[] = [];
  const executor = createPiAgentExecutor(
    { runtime, getApiKey: async () => "test-key", createSearchProvider: () => { throw new Error("unexpected search"); } },
    { tools, ...(handoff === undefined ? {} : { handoff }) },
  );
  let error: unknown;
  try {
    await executor.run(
      executionRequest(maxAgentTurns),
      () => ({ messages: [], basePromptParts: [], finalizationPromptParts: [], sessionId: "test" }),
      (event) => events.push(event),
      new AbortController().signal,
    );
  } catch (caught) {
    error = caught;
  }
  return { events, error };
}

describe("Pi execution handoff", () => {
  it("pairs every call in a read-wait-write batch while stopping the write and next model turn", async () => {
    const handoff = createExecutionHandoff();
    const readSpy = vi.fn(async () => ({ content: [{ type: "text" as const, text: "read" }], details: {} }));
    const writeSpy = vi.fn(async () => ({ content: [{ type: "text" as const, text: "written" }], details: {} }));
    const recording = setup([toolTurn(["read", "ask", "write"]), assistant("unexpected follow-up")]);

    const result = await run(recording.runtime, [
      tool("read", readSpy),
      tool("ask", async () => { handoff.request(); return { content: [{ type: "text", text: "waiting" }], details: {} }; }),
      tool("write", writeSpy),
    ], handoff);

    const toolResults = recording.messages.filter((message) => message.role === "toolResult");
    expect(result.error).toBeUndefined();
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(recording.requests).toHaveLength(1);
    expect(toolResults.map((message) => message.toolCallId)).toEqual(["read", "ask", "write"]);
    expect(toolResults.find((message) => message.role === "toolResult" && message.toolCallId === "write")?.isError).toBe(true);
    expect(result.events).toContainEqual(expect.objectContaining({ type: "tool_activity", toolCallId: "write", status: "skipped", budgetConsumed: false }));
    expect(result.events.at(-1)).toMatchObject({ type: "handed_off", requestId: "req-1" });
  });

  it("finishes an ordinary tool turn when no handoff is supplied", async () => {
    const writeSpy = vi.fn(async () => ({ content: [{ type: "text" as const, text: "written" }], details: {} }));
    const recording = setup([toolTurn(["write"]), assistant("已完成")]);

    const result = await run(recording.runtime, [tool("write", writeSpy)]);

    expect(result.error).toBeUndefined();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(recording.requests).toHaveLength(2);
    expect(result.events.at(-1)).toEqual({ requestId: "req-1", type: "completed", text: "已完成" });
  });

  it("reserves the final model turn at the agent turn budget without a handoff", async () => {
    const readSpy = vi.fn(async () => ({ content: [{ type: "text" as const, text: "read" }], details: {} }));
    const recording = setup([toolTurn(["read"]), assistant("根据资料已完成")]);

    const result = await run(recording.runtime, [tool("read", readSpy)], undefined, 2);

    expect(result.error).toBeUndefined();
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(recording.requests).toHaveLength(2);
    expect(recording.requests[1]?.tools).toEqual([]);
    expect(result.events.at(-1)).toEqual({ requestId: "req-1", type: "completed", text: "根据资料已完成" });
  });

  it("accepts handed_off as a terminal worker event", async () => {
    const endpoint = new InMemoryEndpoint();
    const agent: ChatAgent = {
      async run(workerRequest, emit) {
        emit({ requestId: workerRequest.requestId, type: "started" });
        emit({ requestId: workerRequest.requestId, type: "handed_off" });
      },
    };
    createWorkerMessageLoop(endpoint, agent);

    endpoint.emit(request());
    await flushPending();

    expect(Value.Check(AgentWorkerEventSchema, { requestId: "req-1", type: "handed_off" })).toBe(true);
    expect(endpoint.posted).toEqual([
      { requestId: "req-1", type: "started" },
      { requestId: "req-1", type: "handed_off" },
    ]);
    expect(isChatTerminal({ requestId: "req-1", type: "handed_off" })).toBe(true);
  });
});
