import { ToolExecutionError, type ToolDefinition } from "@deepfield/tool-platform";
import { SearchResourceError, ParseHtmlInputSchema, ParseHtmlOutputSchema } from "@deepfield/base/search";
import { createHtmlParser, type ParseHtmlDeps } from "@deepfield/base/search/runtime";
import { scopeFromContext } from "./fetch-tools.js";
export { ParseHtmlInputSchema, ParseHtmlOutputSchema, HtmlLinkSchema, HtmlLocatorSchema, type HtmlLink, type HtmlLocator, type ParseHtmlInput, type ParseHtmlOutput } from "@deepfield/base/search";
export type { ParseHtmlDeps } from "@deepfield/base/search/runtime";

export function createParseHtmlDefinition(deps: ParseHtmlDeps): ToolDefinition<typeof ParseHtmlInputSchema, typeof ParseHtmlOutputSchema> {
  const parse = createHtmlParser(deps);
  return {
    identity: { name: "parse_html", version: 1 },
    label: "Parse HTML",
    description: "Parse a stored HTML resource into normalized text, links and structural locators.",
    inputSchema: ParseHtmlInputSchema,
    outputSchema: ParseHtmlOutputSchema,
    effect: "project.read",
    timeoutMs: 30_000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 2,
    meter: { category: "parse", countsBytes: false, countsTime: true },
    async execute(input, context, signal) {
      try { return await parse(input.resourceId, scopeFromContext(context), signal); }
      catch (error) {
        if (error instanceof SearchResourceError) throw new ToolExecutionError(error.code);
        throw error;
      }
    },
  };
}
