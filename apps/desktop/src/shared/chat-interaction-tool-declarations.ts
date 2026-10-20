import { Type } from "typebox";
import { ActionCallSchema, TaskScopeProposalSchema } from "@deepfield/capability-sdk";

/** Pure declarations shared by Chat and the single-request Settings compatibility probe. */
export const chatInteractionToolDeclarations = [
  { name: "request_user_input", description: "Ask one short question and yield until the real user answers. Use up to six choices. Never use this to approve an operation.",
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 4000 }), options: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }) }, { additionalProperties: false }), { maxItems: 6 })) }, { additionalProperties: false }) },
  { name: "interaction_draft", description: "Read, update or transition only the host-bound current approval draft. For user edits (such as change the note), read the revision then update this draft instead of invoking a new action. Transitions only change form steps; they never execute resource actions or approve.",
    parameters: Type.Object({ mode: Type.Union([Type.Literal("read"), Type.Literal("update"), Type.Literal("transition")]), expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })), patch: Type.Optional(Type.Unknown()), transitionId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }) },
  { name: "propose_actions", description: "Prepare one visible bounded task scope when the user asks to complete a multi-action task with one confirmation. For a single action or editable draft, use capability_invoke; the host prepares ordinary confirmation before execution. Read each action's taskAuthorization first. For mode=scope, use firstCall, endCondition and 1–10 rules. Each rule freezes a call template, maxExecutions (1–10), optional dynamicFields supported by the action's scope policy, and optional bindings of resource fields to a prior rule's declared successful output path. Omit dynamic/bound fields from template input. All other inputs remain fixed; destructive inputs must be exact, single-use, without dynamic fields or bindings. The host displays scope and resource costs; only a fresh user confirmation grants authority. Execute subsequent actions normally with capability_invoke; never grant or expand scope yourself. Only compatible legacy mode=exact_input actions can use {calls:[...]}. Unsupported packages use capability_invoke for ordinary per-action confirmation. Use exactly one form: either calls alone, or firstCall, endCondition and rules together. Never mix forms or omit required fields. Yields to the user.",
    // Providers require an object root. The host retains the strict union and
    // rejects empty, mixed or incomplete proposals before granting any authority.
    parameters: Type.Object({
      calls: Type.Optional(Type.Array(ActionCallSchema, { minItems: 1, maxItems: 10 })),
      ...Type.Partial(TaskScopeProposalSchema).properties,
    }, { additionalProperties: false }) },
] as const;
