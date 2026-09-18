import { createSearchProvider } from "@deepfield/retrieval";
import type { SearchRuntimeSnapshot } from "@deepfield/contracts";
import { startUsageAttempt } from "./usage-collection.js";

export function createMeteredSearchProvider(snapshot: SearchRuntimeSnapshot) {
  return createSearchProvider(snapshot, { onDispatch() {
    const attempt = startUsageAttempt(snapshot, "search");
    return (outcome, count) => attempt.finish(outcome, outcome === "failed" ? "search_failed" : outcome === "cancelled" ? "cancelled" : null, count);
  } });
}
