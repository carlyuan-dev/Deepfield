import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentWorkerRequest } from "@deepfield/contracts";
import type { HostClient } from "../host-client.js";
import type { ExecutionHandoff } from "../agent/execution-handoff.js";
import { chatInteractionToolDeclarations } from "../../shared/chat-interaction-tool-declarations.js";

/** Chat tools are present even when no capability is installed. No tool can approve. */
export function createPiChatInteractionTools(request: AgentWorkerRequest, host: Pick<HostClient, "request">, handoff: ExecutionHandoff): AgentTool<any>[] {
  const call = async (toolCallId: string, operation: "question" | "draft.read" | "draft.update" | "draft.transition" | "proposal.create", args: unknown) => {
    const reply = await host.request("chat.interaction", { chatRequestId: request.requestId, toolCallId, operation, arguments: args }) as { result: unknown };
    const result = reply.result as { status?: string } | undefined;
    if ((operation === "question" || operation === "proposal.create") && result?.status === "waiting") handoff.request();
    return { content: [{ type: "text" as const, text: JSON.stringify(reply.result) }], details: {} };
  };
  return [
    { ...chatInteractionToolDeclarations[0], label: "Ask user",
      execute: (id, args) => call(id, "question", args) },
    { ...chatInteractionToolDeclarations[1], label: "Current interaction draft",
      execute: (id, args) => call(id, `draft.${(args as { mode: "read" | "update" | "transition" }).mode}`, args) },
    { ...chatInteractionToolDeclarations[2], label: "Prepare task scope",
      execute: (id, args) => call(id, "proposal.create", args) },
  ];
}
