import { SafeHttpTransport } from "../http-transport.js";
import type { LinkChecker } from "./run-benchmark.js";

/**
 * Live link checker built on the already-accepted SafeHttpTransport chain
 * (UrlPolicy, bounded reads, redirect/abort handling). Only valid/total is
 * produced — never page content — so the report never carries web bodies.
 * P2-T8 only wires this; it is exercised by the offline fake in tests.
 */
export function createHttpLinkChecker(transport: SafeHttpTransport): LinkChecker {
  return {
    async check(urls) {
      let valid = 0;
      for (const url of urls) {
        try {
          const result = await transport.fetch(url, { method: "HEAD", signal: new AbortController().signal });
          if (result.statusCode >= 200 && result.statusCode < 400) {
            valid += 1;
          }
        } catch {
          // inaccessible link counts as invalid; never leaks the raw error
        }
      }
      return { valid, total: urls.length };
    },
  };
}
