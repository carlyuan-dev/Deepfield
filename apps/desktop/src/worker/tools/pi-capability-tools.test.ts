import { describe, expect, it, vi } from "vitest";
import type { AgentWorkerRequest } from "@deepfield/contracts";
import { createPiCapabilityTools } from "./pi-capability-tools.js";

const request = (directory: AgentWorkerRequest["context"]["capabilityDirectory"]): AgentWorkerRequest => ({
  requestId: "chat-1", kind: "chat.prompt", prompt: "run", options: { webSearch: false },
  context: { conversationId: "session-A", systemPrompt: "test", messages: [], ...(directory ? { capabilityDirectory: directory } : {}) },
  llm: {} as AgentWorkerRequest["llm"], toolAccess: { network: "disabled", maxAgentTurns: 16, maxSearchCalls: 0, maxFetchCalls: 0 },
});
const entry = { capabilityId: "probe", capabilityName: "Probe", packageVersion: "1.0.0", actionId: "lookup",
  title: "Lookup", description: "Find a record", mode: "immediate" as const,
  effects: { data: "read" as const, consumesResources: false }, contractDigest: `sha256:${"a".repeat(64)}` };

describe("Pi capability tools", () => {
  it("registers no protocol tools without a ready catalog", () => {
    expect(createPiCapabilityTools(request([]), { request: vi.fn() })).toEqual([]);
  });
  it("uses Pi's five AgentTools and correlates calls to the current chat request", async () => {
    const rpc = vi.fn(async () => ({ result: { status: "described", contractDigest: entry.contractDigest } }));
    const tools = createPiCapabilityTools(request([entry]), { request: rpc });
    expect(tools.map(tool => tool.name)).toEqual(["capability_describe", "capability_invoke", "capability_task", "capability_read", "capability_open"]);
    const result = await tools[0]!.execute("tool-7", { capabilityId: "probe", actionId: "lookup" });
    expect(rpc).toHaveBeenCalledWith("capability.call", { chatRequestId: "chat-1", toolCallId: "tool-7", operation: "describe", arguments: { capabilityId: "probe", actionId: "lookup" } });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(entry.contractDigest) });
  });
  it("surfaces safe gateway errors as failed tool execution", async () => {
    const tools = createPiCapabilityTools(request([entry]), { request: async () => ({ result: { status: "error", invocationId: "signed-id", error: { code: "INPUT.INVALID", message: "invalid input", retryable: false, fieldErrors: [{ path: "/field", message: "required" }] } } }) });
    await expect(tools[1]!.execute("tool-8", { capabilityId: "probe", actionId: "lookup", contractDigest: entry.contractDigest, input: {} }))
      .rejects.toThrow(/fieldErrors.*\/field.*signed-id|signed-id.*fieldErrors.*\/field/);
  });
});
