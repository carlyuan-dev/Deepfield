import { ToolExecutionError, type ToolDefinition, type ToolRunContext } from "../index.js";
import { FetchInputSchema, FetchOutputSchema, MAX_HTML_BYTES, MAX_PDF_BYTES, SearchResourceError } from "../../search/index.js";
import { fetchResource, TransportError, type FetchResourceDeps, type ResourceScope } from "../../search/runtime.js";
export { FetchInputSchema, FetchOutputSchema, MAX_HTML_BYTES, MAX_PDF_BYTES, type FetchInput, type FetchOutput } from "../../search/index.js";
export type FetchToolDeps = FetchResourceDeps;
/**
 * Fail-closed scope binding: prefer the trusted ToolSet object itself (direct
 * trusted calls), then the runner-provided snapshot fingerprint. A self-reported
 * fingerprint alone is never accepted, and a missing trusted fingerprint throws
 * instead of falling back to a shared empty authorization domain.
 */
export function scopeFromContext(context: ToolRunContext): ResourceScope {
  const fingerprint =
    context.toolSet !== undefined
      ? context.toolSet.fingerprint()
      : context.toolSetFingerprint;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new ToolExecutionError("executor_failed");
  }
  return {
    traceId: context.traceId,
    ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
    toolSetFingerprint: fingerprint,
  };
}

function makeFetchDefinition(deps: FetchToolDeps, options: { identity: "fetch_url" | "fetch_pdf"; maxBytes: number; acceptedMime: readonly string[] }): ToolDefinition<typeof FetchInputSchema, typeof FetchOutputSchema> {
  return {
    identity: { name: options.identity, version: 1 },
    label: options.identity === "fetch_url" ? "Fetch URL" : "Fetch PDF",
    description:
      options.identity === "fetch_url"
        ? "Fetch a public HTTP(S) page as HTML and store it in the trace resource store."
        : "Fetch a public HTTP(S) PDF and store it in the trace resource store.",
    inputSchema: FetchInputSchema,
    outputSchema: FetchOutputSchema,
    effect: "network.read.public",
    timeoutMs: 40_000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 2,
    meter: { category: "fetch", countsBytes: true, countsTime: true, commitOn: "external_dispatch" },
    async execute(input, context, signal, onProgress) {
      if (signal.aborted) throw new ToolExecutionError("cancelled");
      try { return await fetchResource(deps, options, input.url, scopeFromContext(context), signal, context.markBudgetConsumed, () => onProgress?.({ kind: "fetching" })); }
      catch (error) {
        if (error instanceof SearchResourceError || error instanceof TransportError) throw new ToolExecutionError(error.code);
        throw error;
      }
    },
  };
}
export function createFetchUrlDefinition(deps: FetchToolDeps): ToolDefinition<typeof FetchInputSchema, typeof FetchOutputSchema> {
  return makeFetchDefinition(deps, {
    identity: "fetch_url",
    maxBytes: MAX_HTML_BYTES,
    acceptedMime: ["text/html", "application/xhtml+xml"],
  });
}

export function createFetchPdfDefinition(deps: FetchToolDeps): ToolDefinition<typeof FetchInputSchema, typeof FetchOutputSchema> {
  return makeFetchDefinition(deps, {
    identity: "fetch_pdf",
    maxBytes: MAX_PDF_BYTES,
    acceptedMime: ["application/pdf"],
  });
}
