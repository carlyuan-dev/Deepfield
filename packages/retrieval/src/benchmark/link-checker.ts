import { SafeHttpTransport, TransportError } from "../http-transport.js";
import { checkLinkAccessible } from "../link-tool.js";
import type { LinkChecker } from "./run-benchmark.js";

/**
 * Live link checker built on the SAME accepted accessibility core as
 * check_link_accessibility (HEAD-first with a bounded GET fallback on 405/501,
 * fallback body zero-filled, SafeHttpTransport/UrlPolicy/redirect/timeout
 * chain untouched). Per-URL evidence honors the caller's AbortSignal; ordinary
 * blocked/inaccessible links are accessible=false while unexpected
 * infrastructure failures propagate to the harness.
 */
export function createHttpLinkChecker(transport: Pick<SafeHttpTransport, "fetch">): LinkChecker {
  return {
    async check(url, signal) {
      try {
        const outcome = await checkLinkAccessible({ transport }, url, signal);
        return { url, accessible: outcome.accessible };
      } catch (error) {
        if (signal.aborted || (error instanceof TransportError && error.code === "cancelled")) {
          throw error; // cancellation propagates; never treated as an invalid link
        }
        if (error instanceof TransportError) {
          return { url, accessible: false }; // ordinary blocked/error link
        }
        throw error; // unexpected infrastructure failure
      }
    },
  };
}
