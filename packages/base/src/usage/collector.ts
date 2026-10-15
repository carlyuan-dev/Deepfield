import { createHash } from "node:crypto";
import { normalizeUsageMetrics, parseUsageAttempt, type UsageCollector, type UsageFinish, type UsageRecorder, type UsageStart } from "./contracts.js";

export interface UsageCollectorPorts {
  now(): string;
  createId(): string;
  getRecorder(): UsageRecorder | undefined;
}

export function usageIdentity(value: string, namespace = "profile"): string {
  // Only caller-provided non-secret identifiers are normalized.
  return /^[A-Za-z0-9][A-Za-z0-9_.:/@+~-]{0,199}$/.test(value) && !value.startsWith("legacy-")
    ? value : `legacy-${namespace}-${createHash("sha256").update(value).digest("hex")}`;
}

export function createUsageCollector(ports: UsageCollectorPorts): UsageCollector {
  const revisions = new WeakMap<object, string>();
  function revision(identity?: object): string {
    if (!identity) return ports.createId();
    let value = revisions.get(identity);
    if (!value) { value = ports.createId(); revisions.set(identity, value); }
    return value;
  }
  return { startAttempt(metadata, context, identity) {
    const sink = ports.getRecorder();
    let state: UsageStart = {
      attemptId: ports.createId(), operationId: usageIdentity(context?.operationId ?? ports.createId(), "operation"),
      sourceId: usageIdentity(context?.sourceId ?? "unclassified", "source"),
      ...(context?.taskId ? { taskId: usageIdentity(context.taskId, "task") } : {}),
      ...(context?.stageId ? { stageId: usageIdentity(context.stageId, "stage") } : {}),
      ...(metadata.draftSessionId ? { draftSessionId: usageIdentity(metadata.draftSessionId, "draft") }
        : metadata.profileId !== undefined ? { profileId: usageIdentity(metadata.profileId) } : {}),
      profileName: metadata.profileName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) || "Profile",
      providerId: metadata.providerId, configRevisionId: usageIdentity(metadata.configRevisionId ?? revision(identity), "revision"),
      ...(metadata.serviceKind === "llm" && metadata.modelId !== undefined ? { modelId: metadata.modelId } : {}),
      serviceKind: metadata.serviceKind, startedAt: ports.now(), finishedAt: null, durationMs: null,
      outcome: "running", revision: 1, attemptCountStatus: "complete", errorCode: null,
      ...normalizeUsageMetrics({}), resultCount: null,
    };
    let ended = false;
    function deliver(value: UsageStart | UsageFinish) {
      if (!sink) return;
      try {
        const safe = parseUsageAttempt(value);
        void (safe.outcome === "running" ? sink.recordStart(safe) : sink.recordFinish(safe)).catch(() => {});
      } catch { /* Best effort; delivery health remains owned by the recorder. */ }
    }
    deliver(state);
    return {
      operationId: state.operationId, attemptId: state.attemptId,
      update(metrics) {
        if (ended) return;
        state = { ...state, ...normalizeUsageMetrics(metrics), revision: state.revision + 1 };
        deliver(state);
      },
      finish(outcome, errorCode = null, resultCount = null) {
        if (ended) return;
        ended = true;
        const finishedAt = ports.now();
        deliver({ ...state, revision: state.revision + 1, outcome, errorCode, resultCount, finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(state.startedAt)) });
      },
    };
  } };
}
