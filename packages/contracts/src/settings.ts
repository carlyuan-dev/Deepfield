import { Type, type Static } from "typebox";
import { PublicAppErrorSchema } from "./errors.js";
import {
  LlmProfileViewSchema,
  SearchProfileViewSchema,
  SearchProviderManifestSchema,
} from "./model-config.js";

export * from "./model-config.js";
export { ToolAccessPolicySchema, type ToolAccessPolicy } from "./tools.js";

const Id = Type.String({ minLength: 1, maxLength: 200 });

export const SettingsViewSchema = Type.Object({ schemaVersion: Type.Literal(1), llm: Type.Object({ activeProfileId: Type.Union([Id, Type.Null()]), profiles: Type.Array(LlmProfileViewSchema) }, { additionalProperties: false }), search: Type.Object({ activeProfileId: Type.Union([Id, Type.Null()]), profiles: Type.Array(SearchProfileViewSchema), manifests: Type.Array(SearchProviderManifestSchema) }, { additionalProperties: false }) }, { additionalProperties: false });
export type SettingsView = Static<typeof SettingsViewSchema>;
export const DiagnosticResultSchema = Type.Union([Type.Object({ ok: Type.Literal(true), latencyMs: Type.Integer({ minimum: 0 }), summary: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }), Type.Object({ ok: Type.Literal(false), error: Type.Optional(PublicAppErrorSchema), latencyMs: Type.Integer({ minimum: 0 }), code: Type.Union([Type.Literal("invalid_config"), Type.Literal("unauthorized"), Type.Literal("network"), Type.Literal("provider_error")]), message: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false })]);
export type DiagnosticResult = Static<typeof DiagnosticResultSchema>;
