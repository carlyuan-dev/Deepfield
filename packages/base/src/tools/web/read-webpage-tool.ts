import { ReadWebpageOutputSchema, FetchInputSchema, SearchResourceError } from "../../search/index.js";
import { createWebpageReader, TransportError } from "../../search/runtime.js";
export { MAX_READ_WEBPAGE_TEXT_CHARS, ReadWebpageOutputSchema, type ReadWebpageOutput } from "../../search/index.js";
import { ToolExecutionError, type ToolDefinition } from "../index.js";
import { scopeFromContext, type FetchToolDeps } from "./fetch-tools.js";

/**
 * Model-facing webpage reader. The internal resource hand-off stays scoped to
 * the trace, while the model receives only bounded normalized page content.
 */
export function createReadWebpageDefinition(
  deps: FetchToolDeps,
): ToolDefinition<typeof FetchInputSchema, typeof ReadWebpageOutputSchema> {
  const read = createWebpageReader(deps);
  return {
    identity: { name: "read_webpage", version: 1 },
    label: "Read Webpage",
    userFacing: { name: "读取网页", description: "读取公开网页内容" },
    description:
      "Open one public HTTP(S) webpage and return bounded readable text. Use URLs returned by web_search to verify important claims.",
    inputSchema: FetchInputSchema,
    outputSchema: ReadWebpageOutputSchema,
    effect: "network.read.public",
    timeoutMs: 40_000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 2,
    meter: {
      category: "fetch",
      countsBytes: true,
      countsTime: true,
      commitOn: "external_dispatch",
    },
    model: {
      formatOutput: (output) => JSON.stringify(output),
    },
    async execute(input, context, signal, onProgress) {
      if (signal.aborted) throw new ToolExecutionError("cancelled");
      try { return await read(input.url, scopeFromContext(context), signal, context.markBudgetConsumed, () => onProgress?.({ kind: "fetching" })); }
      catch (error) {
        if (error instanceof SearchResourceError || error instanceof TransportError) throw new ToolExecutionError(error.code);
        throw error;
      }
    },
  };
}
