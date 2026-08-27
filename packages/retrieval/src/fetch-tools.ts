import { Type, type Static } from "typebox";
import {
  ToolExecutionError,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepfield/tool-platform";
import { TransportError, type SafeHttpTransport } from "./http-transport.js";
import { ResourceStore, type ResourceScope } from "./resource-store.js";

export const MAX_HTML_BYTES = 8 * 1024 * 1024;
export const MAX_PDF_BYTES = 32 * 1024 * 1024;

export const FetchInputSchema = Type.Object(
  { url: Type.String({ minLength: 1, maxLength: 2048 }) },
  { additionalProperties: false },
);
export type FetchInput = Static<typeof FetchInputSchema>;

export const FetchOutputSchema = Type.Object(
  {
    resourceId: Type.String({ minLength: 1 }),
    finalUrl: Type.String({ minLength: 1 }),
    contentType: Type.String({ minLength: 1 }),
    size: Type.Integer({ minimum: 0 }),
    sha256: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type FetchOutput = Static<typeof FetchOutputSchema>;

export interface FetchToolDeps {
  transport: SafeHttpTransport;
  store: ResourceStore;
}

export function scopeFromContext(context: ToolRunContext): ResourceScope {
  return {
    traceId: context.traceId,
    ...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
    // The runner provides the trusted ToolSet fingerprint in the snapshot
    // scope; direct (test) calls fall back to the ToolSet itself.
    toolSetFingerprint: context.toolSetFingerprint ?? context.toolSet?.fingerprint() ?? "",
  };
}

function toToolFailure(error: unknown): never {
  if (error instanceof ToolExecutionError) {
    throw error;
  }
  if (error instanceof TransportError) {
    throw new ToolExecutionError(error.code);
  }
  throw new ToolExecutionError("executor_failed");
}

function makeFetchDefinition(
  deps: FetchToolDeps,
  options: { identity: "fetch_url" | "fetch_pdf"; maxBytes: number; acceptedMime: readonly string[] },
): ToolDefinition<typeof FetchInputSchema, typeof FetchOutputSchema> {
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
    meter: { category: "fetch", countsBytes: true, countsTime: true },
    async execute(input, context, signal, onProgress) {
      if (signal.aborted) {
        throw new ToolExecutionError("cancelled");
      }
      try {
        onProgress?.({ kind: "fetching" });
        const result = await deps.transport.fetch(input.url, {
          signal,
          maxBodyBytes: options.maxBytes,
        });
        const mime = result.contentType;
        if (!options.acceptedMime.includes(mime)) {
          throw new ToolExecutionError("unsupported_content_type");
        }
        if (signal.aborted) {
          // never leave a resource when the caller cancelled before the put
          throw new ToolExecutionError("cancelled");
        }
        const scope = scopeFromContext(context);
        let resourceId: string | undefined;
        try {
          const { id } = deps.store.put(scope, result.body, {
            finalUrl: result.finalUrl,
            contentType: mime,
            size: result.decompressedBytes,
            sha256: result.sha256,
          });
          resourceId = id;
          return {
            resourceId: id,
            finalUrl: result.finalUrl,
            contentType: mime,
            size: result.decompressedBytes,
            sha256: result.sha256,
          };
        } catch (error) {
          // If the resource was created but output construction failed, clean
          // it up so no orphan survives this call.
          if (resourceId !== undefined) {
            deps.store.consume(resourceId, scope);
          }
          toToolFailure(error);
        }
      } catch (error) {
        toToolFailure(error);
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
