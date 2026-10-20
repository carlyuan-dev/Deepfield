import type { SearchRuntimeSnapshot } from "../config/search.js";
import type { UsageAttemptHandle, UsageMetadata } from "../usage/contracts.js";
import { createSearchProvider, type SearchProviderCollectionOptions } from "./providers/provider-registry.js";

export interface SearchUsagePort {
  startAttempt(metadata: UsageMetadata, identity?: object): UsageAttemptHandle;
}

export interface SearchRuntimeOptions {
  usage: SearchUsagePort;
  snapshotIdentity: (snapshot: object) => object;
}

/** Bind usage to the same immutable configuration snapshot as the provider. */
export function createMeteredSearchProvider(runtime: SearchRuntimeOptions, snapshot: SearchRuntimeSnapshot, options: Pick<SearchProviderCollectionOptions, "transport"> = {}) {
  return createSearchProvider(snapshot, { ...options, onDispatch() {
    const identity = runtime.snapshotIdentity(snapshot);
    const attempt = runtime.usage.startAttempt({
      ...(snapshot.draftSessionId ? { draftSessionId: snapshot.draftSessionId } : { profileId: snapshot.id }),
      profileName: snapshot.name, providerId: snapshot.provider, serviceKind: "search",
      ...(snapshot.configRevisionId !== undefined ? { configRevisionId: snapshot.configRevisionId } : {}),
    }, identity);
    return (outcome, count) => attempt.finish(outcome, outcome === "failed" ? "search_failed" : outcome === "cancelled" ? "cancelled" : null, count);
  } });
}
