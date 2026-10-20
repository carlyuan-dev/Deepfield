import { SearchResourceError } from "./errors.js";
import { TransportError, type SafeHttpTransport } from "./http-transport.js";
import { ResourceStore, zeroFillBuffer, type ResourceScope } from "./resource-store.js";
import type { FetchOutput } from "./parsing-contracts.js";
export interface FetchResourceDeps { transport: Pick<SafeHttpTransport, "fetch">; store: ResourceStore; }
export async function fetchResource(deps: FetchResourceDeps, options: { maxBytes: number; acceptedMime: readonly string[] }, url: string, resourceScope: ResourceScope, signal: AbortSignal, onExternalDispatch?: () => void, onProgress?: () => void): Promise<FetchOutput> {
  if (signal.aborted) {
    throw new SearchResourceError("cancelled");
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
    onProgress?.();
    result = await deps.transport.fetch(url, {
      signal,
      maxBodyBytes: options.maxBytes,
      ...(onExternalDispatch === undefined
        ? {}
        : { onExternalDispatch: onExternalDispatch }),
    });
    const mime = result.contentType;
    if (!options.acceptedMime.includes(mime)) {
      throw new SearchResourceError("unsupported_content_type");
    }
    if (signal.aborted) {
      throw new SearchResourceError("cancelled");
    }
    scope = resourceScope;
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
      throw new SearchResourceError("cancelled");
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
    if (error instanceof SearchResourceError || error instanceof TransportError) throw error;
    throw new SearchResourceError("executor_failed");
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (result !== undefined) {
      zeroFillBuffer(result.body); // best-effort: the copy is in the store
    }
  }
}
