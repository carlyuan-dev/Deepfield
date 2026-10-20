import { fetchResource, type FetchResourceDeps } from "./fetch-resource.js";
import { createHtmlParser } from "./html-parser.js";
import { MAX_HTML_BYTES } from "./parsing-contracts.js";
import { MAX_READ_WEBPAGE_TEXT_CHARS, type ReadWebpageOutput } from "./output-contracts.js";
import type { ResourceScope } from "./resource-store.js";

export function createWebpageReader(deps: FetchResourceDeps) {
  const parse = createHtmlParser({ store: deps.store, maxChars: MAX_READ_WEBPAGE_TEXT_CHARS, maxLinks: 500 });
  return async (url: string, scope: ResourceScope, signal: AbortSignal, onExternalDispatch?: () => void, onProgress?: () => void): Promise<ReadWebpageOutput> => {
    const fetched = await fetchResource(deps, { maxBytes: MAX_HTML_BYTES, acceptedMime: ["text/html", "application/xhtml+xml"] }, url, scope, signal, onExternalDispatch, onProgress);
    const parsed = await parse(fetched.resourceId, scope, signal);
    return {
      title: parsed.title, url: parsed.canonicalUrl, requestedUrl: url, finalUrl: fetched.finalUrl,
      text: parsed.text, truncated: parsed.truncated, characterCount: parsed.characterCount,
    };
  };
}
