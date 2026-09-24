import { Type, type TSchema } from "typebox";
import { defineAction, DraftRefSchema, type ActionDefinition, type ActionInvocationContext, type ActionOutcome, type OperationPresentation, type TaskAuthorization } from "@deepfield/capability-sdk";
import { RESEARCH_DIRECTIONS, StartCompanyResearchInputSchema, CreateIndustryResearchItemInputSchema, type ResearchDirection } from "../contracts/index.js";
import { topicActions, companyActions, researchActions, reportActions } from "./domain-definitions.js";
export const id = Type.String({ minLength: 1, maxLength: 200 });
export const ids = Type.Array(id, { minItems: 1, maxItems: 100 });
const cursor = Type.Optional(Type.String({ minLength: 1, maxLength: 2000 }));
export const page = { cursor, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) };
export const BatchEntrySchema = Type.Object({ companyId: id, input: StartCompanyResearchInputSchema }, { additionalProperties: false });
export const BatchInputSchema = Type.Object({ itemId: id, entries: Type.Array(BatchEntrySchema, { minItems: 1, maxItems: 100 }) }, { additionalProperties: false });
export const TargetSchema = Type.Object({ itemId: id, companyId: id }, { additionalProperties: false });
export const RunTargetSchema = Type.Object({ itemId: id, companyId: id, runId: id }, { additionalProperties: false });
export const ResearchParametersSchema = Type.Object({ itemId: id, companyId: id,
  direction: Type.Unsafe<ResearchDirection>({ type: "string", enum: [...RESEARCH_DIRECTIONS] }),
  asOfDate: Type.String({ minLength: 10, maxLength: 10 }), focusScope: Type.Optional(Type.String({ maxLength: 1000 })),
}, { additionalProperties: false });
export const PreparedResearchSchema = Type.Object({ draftRef: DraftRefSchema, parameters: ResearchParametersSchema }, { additionalProperties: false });
export const DraftUpdateSchema = Type.Object({ draftRef: DraftRefSchema, parameters: ResearchParametersSchema }, { additionalProperties: false });
export const viewDeclarations = [
  { id: "topics", inputSchema: Type.Object({}, { additionalProperties: false }) },
  { id: "form", inputSchema: Type.Object({ draftId: id, revision: id }, { additionalProperties: false }) },
  { id: "companies", inputSchema: Type.Object({ itemId: id }, { additionalProperties: false }) },
  { id: "company", inputSchema: Type.Object({ itemId: id, companyId: id }, { additionalProperties: false }) },
  { id: "report", inputSchema: Type.Object({ itemId: id, companyId: id, runId: id, revision: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }) },
  { id: "research-draft", inputSchema: Type.Object({ draftId: id, revision: id }, { additionalProperties: false }) },
];
export type PublicHandler = (id: string, input: any, context: ActionInvocationContext) => ActionOutcome<TSchema> | Promise<ActionOutcome<TSchema>>;
export type InputPresentation = { title: string; fields: Array<{ label: string; value: string }> };
export type InputPresenter = (id: string, input: any) => InputPresentation | Promise<InputPresentation>;
export type OperationPresenter = (id: string, input: any) => OperationPresentation | undefined | Promise<OperationPresentation | undefined>;
export interface ActionSpec { id: string; title: string; description: string; input: TSchema; output: TSchema; effect?: "write" | "destructive"; paid?: boolean; confirmation?: boolean; mode?: "task" | "immediate"; taskAuthorization?: TaskAuthorization }
export const simpleResult = Type.Object({ message: Type.String(), summary: Type.Optional(Type.String()), item: Type.Optional(Type.Unknown()), items: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 100 })), nextCursor: cursor, accepted: Type.Optional(Type.Boolean()), status: Type.Optional(Type.String()), viewRef: Type.Optional(Type.Unknown()), artifactRef: Type.Optional(Type.Unknown()) }, { additionalProperties: false });
export const paginated = Type.Object({ items: Type.Array(Type.Unknown(), { maxItems: 20 }), nextCursor: cursor }, { additionalProperties: false });
/** Build and activation consume this exact catalog. Business handlers are bound at activation. */
export function createActionDefinitions(handle: PublicHandler = () => { throw new Error("unbound_action"); }, present?: InputPresenter, presentOperation?: OperationPresenter): ActionDefinition[] {
  const specs = [...topicActions(), ...companyActions(), ...researchActions(), ...reportActions()];
  return specs.map(spec => defineAction({
    id: spec.id, title: spec.title, description: spec.description, inputSchema: spec.input, outputSchema: spec.output,
    mode: spec.mode ?? "immediate", effects: { data: spec.effect ?? "read", consumesResources: !!spec.paid },
    permissions: spec.paid ? ["execute"] : spec.effect ? ["write"] : ["read"],
    requiresConfirmation: !!spec.confirmation, documentation: { path: `docs/actions/${spec.id}.md`, version: "1" },
    ...(spec.taskAuthorization ? { taskAuthorization: spec.taskAuthorization } : {}),
    presentInput: (input: unknown) => present?.(spec.id, input) ?? { title: spec.title, fields: [] },
    ...(spec.taskAuthorization?.mode === "scope" ? { presentTaskScope: (input: Record<string, unknown>) => present?.(spec.id, input) ?? { title: spec.title, fields: [] } } : {}),
    presentOperation: (input: unknown) => presentOperation?.(spec.id, input),
    handler: (input, context) => handle(spec.id, input, context),
  } as ActionDefinition));
}
