import { expect, it, vi } from "vitest";
import type { AgentWorkerRequest } from "@deepfield/contracts";
import { createPiChatInteractionTools } from "./pi-chat-interaction-tools.js";
import { createExecutionHandoff } from "../agent/execution-handoff.js";
it("registers questions without capabilities and only hands off the asking run", async () => {
  const request = { requestId: "r", context: {} } as AgentWorkerRequest;
  const host = { request: vi.fn(async () => ({ result: { id: "interaction" } })) };
  const a = createExecutionHandoff(); const b = createExecutionHandoff();
  const tools = createPiChatInteractionTools(request, host, a);
  expect(tools.map(tool => tool.name)).toEqual(["request_user_input", "interaction_draft", "propose_actions"]);
  await tools[0]!.execute("tool", { question: "Which?" });
  expect(host.request).toHaveBeenCalledWith("chat.interaction", { chatRequestId: "r", toolCallId: "tool", operation: "question", arguments: { question: "Which?" } });
  expect(a.isRequested()).toBe(true); expect(b.isRequested()).toBe(false);
  expect(tools.some(tool => tool.name.includes("approve"))).toBe(false);
});

it("hands off a concrete proposal without exposing an approval operation", async () => {
  const handoff = createExecutionHandoff();
  const host = { request: vi.fn(async () => ({ result: { id: "proposal" } })) };
  const tools = createPiChatInteractionTools({ requestId: "r", context: {} } as AgentWorkerRequest, host, handoff);
  const proposal = tools.find(tool => tool.name === "propose_actions");
  expect(proposal).toBeDefined();
  const calls = [{ capabilityId: "records", actionId: "add", contractDigest: `sha256:${"a".repeat(64)}`, input: { name: "甲" } }];
  await proposal!.execute("propose", { calls });
  expect(host.request).toHaveBeenCalledWith("chat.interaction", { chatRequestId: "r", toolCallId: "propose", operation: "proposal.create", arguments: { calls } });
  expect(handoff.isRequested()).toBe(true);
});
