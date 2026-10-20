import { createMeteredSearchProvider as createBaseMeteredSearchProvider } from "@deepfield/base/search/runtime";
import type { SearchRuntimeSnapshot } from "@deepfield/base/config";
import { modelUsagePort, snapshotIdentity } from "./usage-collection.js";

export function createMeteredSearchProvider(snapshot: SearchRuntimeSnapshot) {
  return createBaseMeteredSearchProvider({ usage: modelUsagePort, snapshotIdentity }, snapshot);
}
