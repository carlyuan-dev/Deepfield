import { describe, expect, it } from "vitest";
import type { ChatTranscriptMessage } from "@deepfield/contracts";
import { pairedSessionMessages } from "./chat-session-context.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const turn: ChatTranscriptMessage = { role: "assistant", api: "openai-completions", provider: "test", model: "test", timestamp: 1, usage, stopReason: "toolUse", content: [{ type: "toolCall", id: "a", name: "web_search", arguments: { query: "q" } }, { type: "toolCall", id: "b", name: "read_webpage", arguments: { url: "https://example.test" } }] };
const result = (id: string): ChatTranscriptMessage => ({ role: "toolResult", toolCallId: id, toolName: id === "a" ? "web_search" : "read_webpage", timestamp: 2, content: [{ type: "text", text: "evidence" }], isError: false });

describe("pair-safe Chat context", () => {
  it("drops an incomplete batch on interruption and retains complete evidence without an unaccepted terminal answer", () => {
    expect(pairedSessionMessages([turn, result("a")], false)).toEqual([]);
    const final: ChatTranscriptMessage = { ...turn, stopReason: "stop", content: [{ type: "text", text: "unaccepted answer" }] };
    expect(pairedSessionMessages([turn, result("a"), result("b"), final], false)).toEqual([turn, result("a"), result("b")]);
    expect(pairedSessionMessages([turn, result("a"), result("b"), { ...final, stopReason: "aborted" }], true)).toEqual([turn, result("a"), result("b")]);
  });
});
