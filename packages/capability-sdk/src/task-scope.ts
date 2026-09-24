import { Type, type Static } from "typebox";
import { ActionCallSchema } from "./actions.ts";

/** Package policy, not authority. Only a visible proposal confirmed by a human grants authority. */
export const TaskAuthorizationSchema = Type.Union([
  Type.Object({ family: Type.String({ minLength: 1 }), mode: Type.Literal("exact_input") }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("scope"),
    dynamicFields: Type.Array(Type.String({ minLength: 1 })),
    resourceFields: Type.Array(Type.String({ minLength: 1 })),
    outputBindings: Type.Array(Type.String({ minLength: 1 })),
    fieldLabels: Type.Optional(Type.Record(Type.String(), Type.String({ minLength: 1 }))),
    resourceDescription: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
]);
export type TaskAuthorization = Static<typeof TaskAuthorizationSchema>;
export const TaskScopeRuleSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }), call: ActionCallSchema,
  dynamicFields: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20, uniqueItems: true })),
  bindings: Type.Optional(Type.Record(Type.String(), Type.Object({ ruleId: Type.String({ minLength: 1 }), path: Type.String({ minLength: 1 }) }, { additionalProperties: false }))),
  maxExecutions: Type.Integer({ minimum: 1, maximum: 10 }),
}, { additionalProperties: false });
export const TaskScopeProposalSchema = Type.Object({
  endCondition: Type.String({ minLength: 1, maxLength: 1000 }), firstCall: ActionCallSchema,
  rules: Type.Array(TaskScopeRuleSchema, { minItems: 1, maxItems: 10 }),
}, { additionalProperties: false });
export type TaskScopeProposal = Static<typeof TaskScopeProposalSchema>;
