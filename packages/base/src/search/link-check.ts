import { TransportError, type SafeHttpTransport } from "./http-transport.js";
import { zeroFillBuffer } from "./resource-store.js";
import { MAX_LINK_FALLBACK_BYTES } from "./parsing-contracts.js";
export interface LinkCheckDeps {
  transport: Pick<SafeHttpTransport, "fetch">;
}

export interface LinkAccessibilityOutcome {
  accessible: boolean;
  statusCode: number;
  finalUrl: string;
  contentType: string;
}

function isAccessible(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 400;
}

/**
 * Shared HEAD-first accessibility core (also used by the benchmark live link
 * checker). Only explicit "HEAD not supported" statuses (405/501) trigger a
 * bounded GET fallback; the fallback body is never buffered into the
 * ResourceStore and is zero-filled before returning.
 */
export async function checkLinkAccessible(
  deps: LinkCheckDeps,
  url: string,
  signal: AbortSignal,
  markBudgetConsumed?: () => void,
): Promise<LinkAccessibilityOutcome> {
  if (signal.aborted) {
    throw new TransportError("cancelled");
  }
  try {
    const checkedAt = Date.now();
    markBudgetConsumed?.();
    const head = await deps.transport.fetch(url, {
      method: "HEAD",
      signal,
      maxBodyBytes: 0,
    });
    if (head.statusCode === 405 || head.statusCode === 501) {
      const fallback = await deps.transport.fetch(url, {
        method: "GET",
        signal,
        maxBodyBytes: MAX_LINK_FALLBACK_BYTES,
      });
      try {
        return {
          accessible: isAccessible(fallback.statusCode),
          statusCode: fallback.statusCode,
          finalUrl: fallback.finalUrl,
          contentType: fallback.contentType,
        };
      } finally {
        // the fallback body is never stored or surfaced: zero it
        zeroFillBuffer(fallback.body);
      }
    }
    return {
      accessible: isAccessible(head.statusCode),
      statusCode: head.statusCode,
      finalUrl: head.finalUrl,
      contentType: head.contentType,
    };
  } catch (error) {
    if (error instanceof TransportError) {
      throw error;
    }
    throw new TransportError("network_unavailable");
  }
}
