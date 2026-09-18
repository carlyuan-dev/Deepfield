import { Type, type Static } from "typebox";
import { PublicAppErrorSchema } from "./errors.js";

const Id = Type.String({ minLength: 1, maxLength: 200 });
const HttpsUrl = Type.String({ pattern: "^https://", maxLength: 2000 });
export const LlmProtocolSchema = Type.Union([Type.Literal("openai_compatible"), Type.Literal("anthropic_messages")]);
export type LlmProtocol = Static<typeof LlmProtocolSchema>;
export const LlmProviderPresetIdSchema = Type.Union([Type.Literal("deepseek"), Type.Literal("qwen"), Type.Literal("openai"), Type.Literal("anthropic"), Type.Literal("custom")]);
export type LlmProviderPresetId = Static<typeof LlmProviderPresetIdSchema>;
export const SearchProviderIdSchema = Type.Union([Type.Literal("metaso"), Type.Literal("baidu"), Type.Literal("zhipu"), Type.Literal("tavily"), Type.Literal("serper"), Type.Literal("doubao")]);
export type SearchProviderId = Static<typeof SearchProviderIdSchema>;

export const LLM_PROVIDER_PRESETS = {
  deepseek: { displayName: "DeepSeek", protocol: "openai_compatible", baseUrl: "https://api.deepseek.com" },
  qwen: { displayName: "Qwen", protocol: "openai_compatible", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  openai: { displayName: "OpenAI", protocol: "openai_compatible", baseUrl: "https://api.openai.com/v1" },
  anthropic: { displayName: "Anthropic", protocol: "anthropic_messages", baseUrl: "https://api.anthropic.com" },
  custom: { displayName: "Custom", protocol: "openai_compatible", baseUrl: "" },
} as const;

const LlmBase = { name: Type.String({ minLength: 1, maxLength: 120 }), provider: LlmProviderPresetIdSchema, protocol: LlmProtocolSchema, baseUrl: HttpsUrl, modelId: Type.String({ minLength: 1, maxLength: 200 }), contextWindow: Type.Integer({ minimum: 1024, maximum: 10_000_000 }) };
export const LlmProfileDraftSchema = Type.Object({ id: Type.Optional(Id), ...LlmBase, apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 10000 })) }, { additionalProperties: false });
export type LlmProfileDraft = Static<typeof LlmProfileDraftSchema>;
export const LlmProfileViewSchema = Type.Object({ id: Id, ...LlmBase, hasCredential: Type.Boolean() }, { additionalProperties: false });
export type LlmProfileView = Static<typeof LlmProfileViewSchema>;
const UsageSnapshotFields = { configRevisionId: Type.Optional(Id), draftSessionId: Type.Optional(Id) };
export const LlmRuntimeSnapshotSchema = Type.Object({ id: Id, ...UsageSnapshotFields, ...LlmBase, apiKey: Type.String({ minLength: 1, maxLength: 10000 }) }, { additionalProperties: false });
export type LlmRuntimeSnapshot = Static<typeof LlmRuntimeSnapshotSchema>;

export const JsonOptionsSchema = Type.Record(Type.String(), Type.Unknown());
const SearchBase = { name: Type.String({ minLength: 1, maxLength: 120 }), provider: SearchProviderIdSchema, baseUrl: HttpsUrl, options: JsonOptionsSchema };
export const SearchProfileDraftSchema = Type.Object({ id: Type.Optional(Id), ...SearchBase, apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 10000 })) }, { additionalProperties: false });
export type SearchProfileDraft = Static<typeof SearchProfileDraftSchema>;
export const SearchProfileViewSchema = Type.Object({ id: Id, ...SearchBase, hasCredential: Type.Boolean() }, { additionalProperties: false });
export type SearchProfileView = Static<typeof SearchProfileViewSchema>;
export const SearchRuntimeSnapshotSchema = Type.Object({ id: Id, ...UsageSnapshotFields, ...SearchBase, apiKey: Type.String({ minLength: 1, maxLength: 10000 }) }, { additionalProperties: false });
export type SearchRuntimeSnapshot = Static<typeof SearchRuntimeSnapshotSchema>;

export const SettingsFieldSchema = Type.Object({ key: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }), type: Type.Union([Type.Literal("text"), Type.Literal("select"), Type.Literal("number")]), required: Type.Boolean(), options: Type.Optional(Type.Array(Type.Object({ value: Type.String(), label: Type.String() }, { additionalProperties: false }))) }, { additionalProperties: false });
export type SettingsField = Static<typeof SettingsFieldSchema>;
export const SearchProviderManifestSchema = Type.Object({ id: SearchProviderIdSchema, displayName: Type.String({ minLength: 1 }), defaultBaseUrl: HttpsUrl, optionFields: Type.Array(SettingsFieldSchema), capabilities: Type.Object({ timeFilter: Type.Union([Type.Literal("exact_range"), Type.Literal("relative_recency"), Type.Literal("none")]), domainFilter: Type.Boolean(), publishedDate: Type.Boolean() }, { additionalProperties: false }) }, { additionalProperties: false });
export type SearchProviderManifest = Static<typeof SearchProviderManifestSchema>;
export const ToolAccessPolicySchema = Type.Object({ network: Type.Union([Type.Literal("disabled"), Type.Literal("enabled")]), maxAgentTurns: Type.Integer({ minimum: 1, maximum: 100 }), maxSearchCalls: Type.Integer({ minimum: 0, maximum: 100 }), maxFetchCalls: Type.Integer({ minimum: 0, maximum: 100 }) }, { additionalProperties: false });
export type ToolAccessPolicy = Static<typeof ToolAccessPolicySchema>;

export const SettingsViewSchema = Type.Object({ schemaVersion: Type.Literal(1), llm: Type.Object({ activeProfileId: Type.Union([Id, Type.Null()]), profiles: Type.Array(LlmProfileViewSchema) }, { additionalProperties: false }), search: Type.Object({ activeProfileId: Type.Union([Id, Type.Null()]), profiles: Type.Array(SearchProfileViewSchema), manifests: Type.Array(SearchProviderManifestSchema) }, { additionalProperties: false }) }, { additionalProperties: false });
export type SettingsView = Static<typeof SettingsViewSchema>;
export const DiagnosticResultSchema = Type.Union([Type.Object({ ok: Type.Literal(true), latencyMs: Type.Integer({ minimum: 0 }), summary: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }), Type.Object({ ok: Type.Literal(false), error: Type.Optional(PublicAppErrorSchema), latencyMs: Type.Integer({ minimum: 0 }), code: Type.Union([Type.Literal("invalid_config"), Type.Literal("unauthorized"), Type.Literal("network"), Type.Literal("provider_error")]), message: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false })]);
export type DiagnosticResult = Static<typeof DiagnosticResultSchema>;
