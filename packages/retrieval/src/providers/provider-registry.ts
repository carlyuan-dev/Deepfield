import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SearchProviderManifest, SearchRuntimeSnapshot } from "@deepfield/contracts";
import { ProviderHttpClient, type ProviderEndpoint } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import { SearchProviderError, type SearchProvider } from "../search-provider.js";
import { createBaiduProvider } from "./baidu.js";
import { createMetaSoProvider } from "./metaso.js";
import { createSerperProvider } from "./serper.js";
import { createTavilyProvider } from "./tavily.js";
import { createZhipuProvider, ZHIPU_SEARCH_ENGINES } from "./zhipu.js";

const emptyOptions = Type.Object({}, { additionalProperties: false });
const baiduOptions = Type.Object({
  authHeader: Type.Optional(Type.Union([Type.Literal("authorization"), Type.Literal("x-appbuilder-authorization")])),
}, { additionalProperties: false });
const zhipuOptions = Type.Object({
  searchEngine: Type.Optional(Type.Union(ZHIPU_SEARCH_ENGINES.map((engine) => Type.Literal(engine)))),
}, { additionalProperties: false });

const manifests = Object.freeze([
  { id: "metaso", displayName: "秘塔搜索", defaultBaseUrl: "https://metaso.cn", optionFields: [], capabilities: { timeFilter: "none", domainFilter: false, publishedDate: true } },
  { id: "baidu", displayName: "百度搜索", defaultBaseUrl: "https://qianfan.baidubce.com", optionFields: [{ key: "authHeader", label: "鉴权 Header", type: "select", required: false, options: [{ value: "authorization", label: "Authorization" }, { value: "x-appbuilder-authorization", label: "X-Appbuilder-Authorization" }] }], capabilities: { timeFilter: "exact_range", domainFilter: false, publishedDate: true } },
  { id: "zhipu", displayName: "智谱搜索", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", optionFields: [{ key: "searchEngine", label: "搜索引擎", type: "select", required: false, options: ZHIPU_SEARCH_ENGINES.map((value) => ({ value, label: value })) }], capabilities: { timeFilter: "none", domainFilter: false, publishedDate: true } },
  { id: "tavily", displayName: "Tavily", defaultBaseUrl: "https://api.tavily.com", optionFields: [], capabilities: { timeFilter: "exact_range", domainFilter: false, publishedDate: true } },
  { id: "serper", displayName: "Serper", defaultBaseUrl: "https://google.serper.dev", optionFields: [], capabilities: { timeFilter: "none", domainFilter: false, publishedDate: true } },
] satisfies SearchProviderManifest[]);

export function listSearchProviderManifests(): readonly SearchProviderManifest[] {
  return manifests;
}

function endpoint(baseUrl: string, suffix: string): ProviderEndpoint {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new SearchProviderError("invalid_request"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new SearchProviderError("invalid_request");
  }
  const root = url.pathname.replace(/\/$/, "");
  return { origin: url.origin, pathPrefix: `${root}${suffix}` };
}

export function createSearchProvider(snapshot: SearchRuntimeSnapshot): SearchProvider {
  const schema = snapshot.provider === "baidu" ? baiduOptions : snapshot.provider === "zhipu" ? zhipuOptions : emptyOptions;
  if (!Value.Check(schema, snapshot.options)) throw new SearchProviderError("invalid_request");
  const makeClient = (suffix: string) => new ProviderHttpClient({
    endpoint: endpoint(snapshot.baseUrl, suffix),
    transport: createNodeProviderTransport(),
  });
  switch (snapshot.provider) {
    case "metaso": return createMetaSoProvider({ client: makeClient("/api/v1/search"), token: snapshot.apiKey, allowCustomEndpoint: true });
    case "baidu": return createBaiduProvider({ client: makeClient("/v2/ai_search/web_search"), token: snapshot.apiKey, authHeader: (snapshot.options.authHeader as "authorization" | "x-appbuilder-authorization" | undefined) ?? "authorization", allowCustomEndpoint: true });
    case "zhipu": {
      const searchEngine = snapshot.options.searchEngine as typeof ZHIPU_SEARCH_ENGINES[number] | undefined;
      return createZhipuProvider({
        client: makeClient("/web_search"),
        token: snapshot.apiKey,
        ...(searchEngine === undefined ? {} : { searchEngine }),
      });
    }
    case "tavily": return createTavilyProvider({ client: makeClient("/search"), token: snapshot.apiKey, allowCustomEndpoint: true });
    case "serper": return createSerperProvider({ client: makeClient("/search"), token: snapshot.apiKey, allowCustomEndpoint: true });
  }
}
