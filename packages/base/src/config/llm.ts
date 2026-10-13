import { Type, type Static } from "typebox";

const Id = Type.String({ minLength: 1, maxLength: 200 });
const HttpsUrl = Type.String({ pattern: "^https://", maxLength: 2000 });
export const LlmProtocolSchema = Type.Union([Type.Literal("openai_compatible"), Type.Literal("anthropic_messages")]);
export type LlmProtocol = Static<typeof LlmProtocolSchema>;
export const LlmProviderPresetIdSchema = Type.Union([Type.Literal("deepseek"), Type.Literal("qwen"), Type.Literal("openai"), Type.Literal("anthropic"), Type.Literal("custom")]);
export type LlmProviderPresetId = Static<typeof LlmProviderPresetIdSchema>;
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

export const DEFAULT_DEEPSEEK_MODEL_ID = "deepseek-flash" as const;
