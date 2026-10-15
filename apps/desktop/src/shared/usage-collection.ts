import { createLlmUsageTransport as createBaseLlmUsageTransport } from "@deepfield/base/model/runtime";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { type UsageRecorder, type UsageContext, type UsageMetadata, type ModelUsagePort } from "@deepfield/base/usage";
import { createUsageCollector } from "@deepfield/base/usage/runtime";
import type { LlmRuntimeSnapshot, SearchRuntimeSnapshot } from "@deepfield/contracts";

let recorder: UsageRecorder | undefined;
export function configureUsageRecorder(value: UsageRecorder | undefined): void { recorder = value; }
export type { UsageContext } from "@deepfield/base/usage";
export { usageIdentity } from "@deepfield/base/usage/runtime";
const contexts = new AsyncLocalStorage<UsageContext>();
export function withUsageContext<T>(context: UsageContext, run: () => T): T { return contexts.run({ ...context, operationId: context.operationId ?? randomUUID() }, run); }
const collector = createUsageCollector({ now: () => new Date().toISOString(), createId: randomUUID, getRecorder: () => recorder });
const snapshotIdentities = new WeakMap<object, object>();
export function snapshotIdentity(snapshot: object): object {
  let identity = snapshotIdentities.get(snapshot);
  if (!identity) { identity = Object.freeze({}); snapshotIdentities.set(snapshot, identity); }
  return identity;
}
export const modelUsagePort: ModelUsagePort = {
  startAttempt(metadata, identity) { return collector.startAttempt(metadata, contexts.getStore(), identity); },
};
export function startUsageAttempt(snapshot: LlmRuntimeSnapshot | SearchRuntimeSnapshot, serviceKind: "llm" | "search") {
  const meta = snapshot as typeof snapshot & { configRevisionId?: string; draftSessionId?: string };
  const metadata: UsageMetadata = {
    ...(meta.draftSessionId ? { draftSessionId: meta.draftSessionId } : { profileId: snapshot.id }),
    profileName: snapshot.name, providerId: snapshot.provider,
    ...(meta.configRevisionId !== undefined ? { configRevisionId: meta.configRevisionId } : {}),
    ...(serviceKind === "llm" ? { modelId: (snapshot as LlmRuntimeSnapshot).modelId } : {}),
    serviceKind,
  };
  return modelUsagePort.startAttempt(metadata, snapshotIdentity(snapshot));
}

export function createLlmUsageTransport(snapshot: LlmRuntimeSnapshot, signal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch, onResponseBodyError?: (error: unknown) => void) {
  return createBaseLlmUsageTransport({ usage: modelUsagePort, snapshotIdentity }, snapshot, signal, fetcher, onResponseBodyError);
}
