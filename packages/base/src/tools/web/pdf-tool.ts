import { ToolExecutionError, type ToolDefinition } from "../index.js";
import { SearchResourceError, ParsePdfInputSchema, ParsePdfOutputSchema } from "../../search/index.js";
import { createPdfParser, type ParsePdfDeps } from "../../search/runtime.js";
import { scopeFromContext } from "./fetch-tools.js";
export { ParsePdfInputSchema, ParsePdfOutputSchema, PdfPageTextSchema, type PdfPageText, type ParsePdfInput, type ParsePdfOutput } from "../../search/index.js";
export type { ParsePdfDeps } from "../../search/runtime.js";

export function createParsePdfDefinition(deps: ParsePdfDeps): ToolDefinition<typeof ParsePdfInputSchema, typeof ParsePdfOutputSchema> {
  const parse = createPdfParser(deps);
  return {
    identity: { name: "parse_pdf", version: 1 },
    label: "Parse PDF",
    description: "Parse a stored PDF resource into ordered per-page text and safe metadata.",
    inputSchema: ParsePdfInputSchema,
    outputSchema: ParsePdfOutputSchema,
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
