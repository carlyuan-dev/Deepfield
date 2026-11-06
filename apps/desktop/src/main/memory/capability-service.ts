import type { MemoryService, MemoryWriter, MemoryInput, MemorySourceRef } from "@deepfield/base/memory";
import type { SqliteMemory } from "@deepfield/base/memory/sqlite";

/** Each installed package receives its own bound service; no owner/namespace input. */
export function createCapabilityMemoryService(store: SqliteMemory, ownerId: string, capabilityId: string,
  source: (operationKey: string) => MemorySourceRef, highWatermark: () => number, writable = true) {
  let live = true;
  const readers: Array<{ revoke(): void }> = [];
  const check = () => { if (!live) throw new Error("memory_unavailable"); };
  const bind = (resource = "default"): MemoryService => {
    check();
    const scope = { ownerId, namespace: `capability:${capabilityId}`, scopeKey: resource };
    const sourceFor = (operation: string) => source(JSON.stringify([capabilityId, resource, operation]));
    const reader = store.reader([scope]); readers.push(reader);
    const writer: MemoryWriter = { ...reader,
      remember(input: MemoryInput, options) { check(); return store.writer(scope, { origin: "consumer_confirmed", sources: [sourceFor(options.operationKey)] }).remember(input, options); },
      revise(id, revision, input, options) { check(); return store.writer(scope, { origin: "consumer_confirmed", sources: [sourceFor(options.operationKey)] }).revise(id, revision, input, options); },
      forget(id, revision) { check(); store.writer(scope, { origin: "consumer_confirmed", sources: [sourceFor(`forget:${id}:${revision}`)] }).forget(id, revision); },
    };
    return Object.freeze({ version: 1 as const, reader, ...(writable ? { writer, clear: () => { check(); store.clearScope(scope, highWatermark()); } } : {}),
      resource: (key: string) => { check(); if (!key || key.length > 300) throw new Error("memory_invalid_resource"); return bind(`resource:${key}`); },
    });
  };
  return { service: bind(), dispose() { live = false; for (const reader of readers) reader.revoke(); readers.length = 0; } };
}
