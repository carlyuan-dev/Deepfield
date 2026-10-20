import { Value } from "typebox/value";
import { EmptySearchOptionsSchema, BaiduSearchOptionsSchema, ZhipuSearchOptionsSchema, type SearchRuntimeSnapshot } from "../../config/index.js";
export { listSearchProviderManifests } from "../../config/index.js";
import { ProviderHttpClient, type ProviderEndpoint, type ProviderTransport } from "../provider-http-client.js";
import { createNodeProviderTransport } from "../provider-node-transport.js";
import { SearchProviderError, type SearchProvider } from "../search-provider.js";
import { createBaiduProvider } from "./baidu.js";
import { createDoubaoProvider } from "./doubao.js";
import { createMetaSoProvider } from "./metaso.js";
import { createSerperProvider } from "./serper.js";
import { createTavilyProvider } from "./tavily.js";
import { createZhipuProvider, ZHIPU_SEARCH_ENGINES } from "./zhipu.js";

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

export interface SearchProviderCollectionOptions {
  transport?: ProviderTransport;
  onDispatch?: () => (outcome: "succeeded" | "failed" | "cancelled", resultCount: number | null) => void;
}

export function createSearchProvider(snapshot: SearchRuntimeSnapshot, options: SearchProviderCollectionOptions = {}): SearchProvider {
  // Each invocation gets an isolated client/observer, so concurrent requests
  // cannot overwrite one another's transport lifecycle.
  const base = buildProvider(snapshot, options.transport ?? createNodeProviderTransport());
  if (!options.onDispatch) return base;
  return { ...base, async search(request, signal) {
    const finishes: ReturnType<NonNullable<SearchProviderCollectionOptions["onDispatch"]>>[] = [];
    const transport = options.transport ?? createNodeProviderTransport();
    const provider = buildProvider(snapshot, { request(endpoint, input) {
      try { const finish = options.onDispatch?.(); if (finish) finishes.push(finish); } catch { /* Collection must not prevent transport. */ }
      return transport.request(endpoint, input);
    } });
    let finished = false;
    const finish = (outcome: "succeeded" | "failed" | "cancelled", count: number | null) => { if (finished) return; finished = true; for (const callback of finishes) { try { callback(outcome, count); } catch { /* Nonfatal telemetry. */ } } };
    const onAbort = () => finish("cancelled", null);
    signal.addEventListener("abort", onAbort, { once: true });
    try { const result = await provider.search(request, signal); finish("succeeded", result.results.length); return result; }
    catch (error) { finish(signal.aborted ? "cancelled" : "failed", null); throw error; }
    finally { signal.removeEventListener("abort", onAbort); }
  } };
}

function buildProvider(snapshot: SearchRuntimeSnapshot, transport: ProviderTransport): SearchProvider {
  const schema = snapshot.provider === "baidu" ? BaiduSearchOptionsSchema : snapshot.provider === "zhipu" ? ZhipuSearchOptionsSchema : EmptySearchOptionsSchema;
  if (!Value.Check(schema, snapshot.options)) throw new SearchProviderError("invalid_request");
  const makeClient = (suffix: string) => new ProviderHttpClient({
    endpoint: endpoint(snapshot.baseUrl, suffix),
    transport,
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
    case "doubao": return createDoubaoProvider({ client: makeClient("/search_api/web_search"), token: snapshot.apiKey });
  }
}
