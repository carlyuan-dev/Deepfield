import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createPiChatAgent } from "./pi-chat-agent.js";
import { assistant, capture, makeRecordingInstalledPiRuntime, request } from "./pi-chat-agent-test-helpers.js";

describe("native Pi capability turn budget", () => {
  it("permits a multi-action describe/invoke sequence before its tool-free answer", async () => {
    const calls = Array.from({ length: 8 }, (_, index) => assistant("", {
      content: [{ type: "toolCall", id: `call-${index}`, name: index % 2 ? "capability_invoke" : "capability_describe", arguments: { id: String(index) } }],
      stopReason: "toolUse",
    }));
    const recording = makeRecordingInstalledPiRuntime([...calls, assistant("任务已受理")]);
    const input = request();
    input.toolAccess = { network: "disabled", maxAgentTurns: 16, maxSearchCalls: 0, maxFetchCalls: 0 };
    const executed: string[] = [];
    const result = await capture(createPiChatAgent(recording.runtime, [], undefined, {}, undefined, undefined, undefined,
      "main_agent", undefined, () => ["capability_describe", "capability_invoke"].map(name => ({
        name, label: name, description: name, parameters: Type.Object({ id: Type.String() }),
        async execute(_id: string, args: unknown) { executed.push(`${name}:${(args as { id: string }).id}`); return { content: [{ type: "text" as const, text: "ok" }], details: {} }; },
      }))), undefined, input);
    expect(result.error).toBeUndefined();
    expect(executed).toHaveLength(8);
    expect(recording.requests).toHaveLength(9);
    expect(result.events.at(-1)).toEqual({ requestId: "req-1", type: "completed", text: "任务已受理" });
  });
});
