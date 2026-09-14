import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@deepfield/tool-platform";
import {
  createFetchUrlDefinition,
  FetchInputSchema,
  type FetchOutput,
  type FetchToolDeps,
} from "./fetch-tools.js";
import {
  createParseHtmlDefinition,
  type ParseHtmlOutput,
} from "./html-tool.js";

export const MAX_READ_WEBPAGE_TEXT_CHARS = 12_000;

export const ReadWebpageOutputSchema = Type.Object(
  {
    title: Type.String({ maxLength: 2000 }),
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    text: Type.String({ maxLength: MAX_READ_WEBPAGE_TEXT_CHARS }),
    truncated: Type.Boolean(),
    characterCount: Type.Integer({ minimum: 0, maximum: MAX_READ_WEBPAGE_TEXT_CHARS }),
  },
  { additionalProperties: false },
);
export type ReadWebpageOutput = Static<typeof ReadWebpageOutputSchema>;

/**
 * Model-facing webpage reader. The internal resource hand-off stays scoped to
 * the trace, while the model receives only bounded normalized page content.
 */
export function createReadWebpageDefinition(
  deps: FetchToolDeps,
): ToolDefinition<typeof FetchInputSchema, typeof ReadWebpageOutputSchema> {
  const fetchUrl = createFetchUrlDefinition(deps);
  const parseHtml = createParseHtmlDefinition({
    store: deps.store,
    maxChars: MAX_READ_WEBPAGE_TEXT_CHARS,
    // The composed output omits links, but parsing with the normal cap keeps
    // ordinary link-heavy pages from being reported as text-truncated merely
    // because a model-facing link list is not returned.
    maxLinks: 500,
  });
  return {
    identity: { name: "read_webpage", version: 1 },
    label: "Read Webpage",
    description:
      "Open one public HTTP(S) webpage and return bounded readable text. Use URLs returned by web_search to verify important claims.",
    inputSchema: FetchInputSchema,
    outputSchema: ReadWebpageOutputSchema,
    effect: "network.read.public",
    timeoutMs: 40_000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 2,
    meter: { category: "fetch", countsBytes: true, countsTime: true },
    model: {
      formatOutput: (output) => JSON.stringify(output),
    },
    async execute(input, context, signal, onProgress) {
      const fetched = (await fetchUrl.execute(
        input,
        context,
        signal,
        onProgress,
      )) as FetchOutput;
      const parsed = (await parseHtml.execute(
        { resourceId: fetched.resourceId },
        context,
        signal,
        onProgress,
      )) as ParseHtmlOutput;
      return {
        title: parsed.title,
        url: parsed.canonicalUrl,
        text: parsed.text,
        truncated: parsed.truncated,
        characterCount: parsed.characterCount,
      };
    },
  };
}
