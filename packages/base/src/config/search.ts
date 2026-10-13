import { Type, type Static } from "typebox";

const Id = Type.String({ minLength: 1, maxLength: 200 });
const HttpsUrl = Type.String({ pattern: "^https://", maxLength: 2000 });
export const SearchProviderIdSchema = Type.Union([Type.Literal("metaso"), Type.Literal("baidu"), Type.Literal("zhipu"), Type.Literal("tavily"), Type.Literal("serper"), Type.Literal("doubao")]);
export type SearchProviderId = Static<typeof SearchProviderIdSchema>;

const UsageSnapshotFields = { configRevisionId: Type.Optional(Id), draftSessionId: Type.Optional(Id) };
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

export const ZHIPU_SEARCH_ENGINES = [
  "search_std",
  "search_pro",
  "search_pro_sogou",
  "search_pro_quark",
] as const;
export type ZhipuSearchEngine = (typeof ZHIPU_SEARCH_ENGINES)[number];

export const EmptySearchOptionsSchema = Type.Object({}, { additionalProperties: false });
export const BaiduSearchOptionsSchema = Type.Object({
  authHeader: Type.Optional(Type.Union([Type.Literal("authorization"), Type.Literal("x-appbuilder-authorization")])),
}, { additionalProperties: false });
export const ZhipuSearchOptionsSchema = Type.Object({
  searchEngine: Type.Optional(Type.Union(ZHIPU_SEARCH_ENGINES.map((engine) => Type.Literal(engine)))),
}, { additionalProperties: false });

const manifests = Object.freeze([
  { id: "metaso", displayName: "秘塔搜索", defaultBaseUrl: "https://metaso.cn", optionFields: [], capabilities: { timeFilter: "none", domainFilter: false, publishedDate: true } },
  { id: "baidu", displayName: "百度搜索", defaultBaseUrl: "https://qianfan.baidubce.com", optionFields: [{ key: "authHeader", label: "鉴权 Header", type: "select", required: false, options: [{ value: "authorization", label: "Authorization" }, { value: "x-appbuilder-authorization", label: "X-Appbuilder-Authorization" }] }], capabilities: { timeFilter: "exact_range", domainFilter: false, publishedDate: true } },
  { id: "zhipu", displayName: "智谱搜索", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", optionFields: [{ key: "searchEngine", label: "搜索引擎", type: "select", required: false, options: ZHIPU_SEARCH_ENGINES.map((value) => ({ value, label: value })) }], capabilities: { timeFilter: "none", domainFilter: false, publishedDate: true } },
  { id: "tavily", displayName: "Tavily", defaultBaseUrl: "https://api.tavily.com", optionFields: [], capabilities: { timeFilter: "exact_range", domainFilter: false, publishedDate: true } },
  { id: "serper", displayName: "Serper", defaultBaseUrl: "https://google.serper.dev", optionFields: [], capabilities: { timeFilter: "none", domainFilter: false, publishedDate: true } },
  { id: "doubao", displayName: "豆包搜索 Custom", defaultBaseUrl: "https://open.feedcoopapi.com", optionFields: [], capabilities: { timeFilter: "exact_range", domainFilter: false, publishedDate: true } },
] satisfies SearchProviderManifest[]);

export function listSearchProviderManifests(): readonly SearchProviderManifest[] {
  return manifests;
}
