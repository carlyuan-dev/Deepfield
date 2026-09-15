import { Type, type Static } from "typebox";
import {
  ToolExecutionError,
  type ToolDefinition,
  type ToolRunContext,
} from "@deepfield/tool-platform";
import { TransportError, type SafeHttpTransport } from "./http-transport.js";
import { ResourceStore, zeroFillBuffer, type ResourceScope } from "./resource-store.js";

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
  transport: Pick<SafeHttpTransport, "fetch">;
  store: ResourceStore;
}

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
    meter: { category: "fetch", countsBytes: true, countsTime: true, commitOn: "external_dispatch" },
    async execute(input, context, signal, onProgress) {
      if (signal.aborted) {
        throw new ToolExecutionError("cancelled");
      }
      let result: Awaited<ReturnType<SafeHttpTransport["fetch"]>> | undefined;
      let scope: ResourceScope | undefined;
      let resourceId: string | undefined;
      // Abort after a successful put must consume the fresh resource so no
      // orphan survives the cancelled execution.
      const onAbort = (): void => {
        if (resourceId !== undefined && scope !== undefined) {
          try {
            deps.store.consume(resourceId, scope);
          } catch {
            // consume is idempotent; a second abort listener run is a no-op
          }
          resourceId = undefined;
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        onProgress?.({ kind: "fetching" });
        result = await deps.transport.fetch(input.url, {
          signal,
          maxBodyBytes: options.maxBytes,
          ...(context.markBudgetConsumed === undefined
            ? {}
            : { onExternalDispatch: context.markBudgetConsumed }),
        });
        const mime = result.contentType;
        if (!options.acceptedMime.includes(mime)) {
          throw new ToolExecutionError("unsupported_content_type");
        }
        if (signal.aborted) {
          throw new ToolExecutionError("cancelled");
        }
        scope = scopeFromContext(context);
        const { id } = deps.store.put(scope, result.body, {
          finalUrl: result.finalUrl,
          contentType: mime,
          size: result.decompressedBytes,
          sha256: result.sha256,
        });
        resourceId = id;
        if (signal.aborted) {
          // abort raced the put: the fresh resource is consumed immediately
          deps.store.consume(id, scope);
          resourceId = undefined;
          throw new ToolExecutionError("cancelled");
        }
        return {
          resourceId: id,
          finalUrl: result.finalUrl,
          contentType: mime,
          size: result.decompressedBytes,
          sha256: result.sha256,
        };
      } catch (error) {
        if (resourceId !== undefined && scope !== undefined) {
          try {
            deps.store.consume(resourceId, scope);
          } catch {
            // already consumed by the abort listener
          }
          resourceId = undefined;
        }
        toToolFailure(error);
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (result !== undefined) {
          zeroFillBuffer(result.body); // best-effort: the copy is in the store
        }
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
