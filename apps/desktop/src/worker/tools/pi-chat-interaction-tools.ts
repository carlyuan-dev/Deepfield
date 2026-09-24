import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentWorkerRequest } from "@deepfield/contracts";
import type { HostClient } from "../host-client.js";
import type { ExecutionHandoff } from "../agent/execution-handoff.js";
import { ActionCallSchema, TaskScopeProposalSchema } from "@deepfield/capability-sdk";

/** Chat tools are present even when no capability is installed. No tool can approve. */
export function createPiChatInteractionTools(request: AgentWorkerRequest, host: Pick<HostClient, "request">, handoff: ExecutionHandoff): AgentTool<any>[] {
  const call = async (toolCallId: string, operation: "question" | "draft.read" | "draft.update" | "draft.transition" | "proposal.create", args: unknown) => {
    const reply = await host.request("chat.interaction", { chatRequestId: request.requestId, toolCallId, operation, arguments: args }) as { result: unknown };
    if (operation === "question" || operation === "proposal.create") handoff.request();
    return { content: [{ type: "text" as const, text: JSON.stringify(reply.result) }], details: {} };
  };
  return [
    { name: "request_user_input", label: "Ask user", description: "Ask one short question and yield until the real user answers. Use up to six choices. Never use this to approve an operation.",
      parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }), options: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { maxItems: 6 })) }, { additionalProperties: false }),
      execute: (id, args) => call(id, "question", args) },
    { name: "interaction_draft", label: "Current interaction draft", description: "Read, update or transition only the host-bound current approval draft. For user edits (such as change the note), read the revision then update this draft instead of invoking a new action. Transitions only change form steps; they never execute resource actions or approve.",
      parameters: Type.Object({ mode: Type.Union([Type.Literal("read"), Type.Literal("update"), Type.Literal("transition")]), expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })), patch: Type.Optional(Type.Unknown()), transitionId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
      execute: (id, args) => call(id, `draft.${(args as { mode: "read" | "update" | "transition" }).mode}`, args) },
    { name: "propose_actions", label: "Prepare task scope", description: "Prepare one visible bounded task scope before asking the real user to confirm once. Use firstCall, endCondition and 1–10 rules. Each rule freezes a call template, maxExecutions (1–10), optional dynamicFields supported by the action's scope policy, and optional bindings of resource fields to a prior rule's declared successful output path. Omit dynamic/bound fields from template input. All other inputs remain fixed; destructive inputs must be exact, single-use, without dynamic fields or bindings. The host displays scope and resource costs; only a fresh user confirmation grants authority. Execute subsequent actions normally with capability_invoke; never grant or expand scope yourself. Legacy exact_input packages can use {calls:[...]}. Unsupported packages use ordinary per-action confirmation. Yields to the user.",
      parameters: Type.Union([Type.Object({ calls: Type.Array(ActionCallSchema, { minItems: 1, maxItems: 10 }) }, { additionalProperties: false }), TaskScopeProposalSchema]),
      execute: (id, args) => call(id, "proposal.create", args) },
  ];
}
