import { Type, type Static, type TSchema } from "typebox";
import type { ActionOutcome, OperationPresentation } from "./interaction.js";
import type { TaskAuthorization } from "./task-scope.js";

/** Untrusted call data deliberately excludes identity, permissions and confirmation credentials. */
export const ActionCallSchema = Type.Object({
  capabilityId: Type.String({ minLength: 1 }),
  actionId: Type.String({ minLength: 1 }),
  contractDigest: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
  input: Type.Unknown(),
}, { additionalProperties: false });
export type ActionCall = Static<typeof ActionCallSchema>;

export const ActionEffectsSchema = Type.Object({
  data: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("destructive")]),
  consumesResources: Type.Boolean(),
}, { additionalProperties: false });
export type ActionEffects = Static<typeof ActionEffectsSchema>;

export interface ActionDocumentationSource {
  path: string;
  version: string;
}

export interface CompiledActionDocumentation extends ActionDocumentationSource {
  digest: string;
}

export interface ActionInvocationContext {
  invocationId: string;
  source: "chat" | "ui";
  sessionId?: string;
}

/** Human-facing confirmation copy. This never participates in authorization. */
export interface ActionInputPresentation {
  title: string;
  fields: Array<{ label: string; value: string }>;
}

export interface ActionDefinition<I extends TSchema = TSchema, O extends TSchema = TSchema> {
  id: string;
  title: string;
  description: string;
  mode: "immediate" | "task";
  effects: ActionEffects;
  inputSchema: I;
  outputSchema: O;
  documentation: ActionDocumentationSource;
  permissions: string[];
  requiresConfirmation: boolean;
  /** Opts into bounded proposals of exact inputs; never authorizes a whole family. */
  taskAuthorization?: TaskAuthorization;
  presentInput?(input: Static<I>): ActionInputPresentation | Promise<ActionInputPresentation>;
  /** Non-mutating presentation of fixed scope fields; dynamic fields/resources may be absent. */
  presentTaskScope?(fixedInput: Record<string, unknown>): ActionInputPresentation | Promise<ActionInputPresentation>;
  /** Optional, non-mutating preview copy. Failure never blocks the action. */
  presentOperation?(input: Static<I>): OperationPresentation | undefined | Promise<OperationPresentation | undefined>;
  handler(input: Static<I>, context: ActionInvocationContext): ActionOutcome<O> | Promise<ActionOutcome<O>>;
}

export interface CompiledActionDeclaration {
  id: string;
  title: string;
  description: string;
  mode: "immediate" | "task";
  effects: ActionEffects;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  documentation: CompiledActionDocumentation;
  permissions: string[];
  requiresConfirmation: boolean;
  taskAuthorization?: TaskAuthorization;
  contractDigest: string;
}

export interface RegisteredAction<I extends TSchema = TSchema, O extends TSchema = TSchema> {
  definition: ActionDefinition<I, O>;
  declaration: CompiledActionDeclaration;
}

/** Deterministic, runtime-neutral serialization used for contract parity and hashing. */
export function canonicalActionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalActionJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalActionJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Defines the single source used by both package builds and runtime registration. */
export function defineAction<I extends TSchema, O extends TSchema>(definition: ActionDefinition<I, O>): ActionDefinition<I, O> {
  return definition;
}
