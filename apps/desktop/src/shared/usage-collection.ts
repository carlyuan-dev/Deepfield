import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeUsageMetrics, parseUsageAttempt, type UsageMetrics, type UsageRecorder, type UsageStart, type UsageFinish } from "@deepfield/base/usage";
import type { LlmRuntimeSnapshot, SearchRuntimeSnapshot } from "@deepfield/contracts";

let recorder: UsageRecorder | undefined;
export function configureUsageRecorder(value: UsageRecorder | undefined): void { recorder = value; }
export interface UsageContext { sourceId: string; operationId?: string; taskId?: string; stageId?: string }
const contexts = new AsyncLocalStorage<UsageContext>();
export function withUsageContext<T>(context: UsageContext, run: () => T): T { return contexts.run({ ...context, operationId: context.operationId ?? randomUUID() }, run); }
export function usageIdentity(value: string, namespace = "profile"): string {
  // Hash only an existing non-secret identifier; never configuration or credentials.
  return /^[A-Za-z0-9][A-Za-z0-9_.:/@+~-]{0,199}$/.test(value) && !value.startsWith("legacy-")
    ? value : `legacy-${namespace}-${createHash("sha256").update(value).digest("hex")}`;
}
const fallbackRevisions = new WeakMap<object, string>();
function revision(snapshot: object): string { let value = fallbackRevisions.get(snapshot); if (!value) { value = randomUUID(); fallbackRevisions.set(snapshot, value); } return value; }
export function startUsageAttempt(snapshot: LlmRuntimeSnapshot | SearchRuntimeSnapshot, serviceKind: "llm" | "search") {
  const sink = recorder;
  const context = contexts.getStore();
  const meta = snapshot as typeof snapshot & { configRevisionId?: string; draftSessionId?: string };
  let state: UsageStart = {
    attemptId: randomUUID(), operationId: usageIdentity(context?.operationId ?? randomUUID(), "operation"),
    sourceId: usageIdentity(context?.sourceId ?? "unclassified", "source"),
    ...(context?.taskId ? { taskId: usageIdentity(context.taskId, "task") } : {}),
    ...(context?.stageId ? { stageId: usageIdentity(context.stageId, "stage") } : {}),
    ...(meta.draftSessionId ? { draftSessionId: usageIdentity(meta.draftSessionId, "draft") } : { profileId: usageIdentity(snapshot.id) }),
    profileName: snapshot.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120) || "Profile",
    providerId: snapshot.provider, configRevisionId: usageIdentity(meta.configRevisionId ?? revision(snapshot), "revision"),
    ...(serviceKind === "llm" ? { modelId: (snapshot as LlmRuntimeSnapshot).modelId } : {}),
    serviceKind, startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
    outcome: "running", revision: 1, attemptCountStatus: "complete", errorCode: null,
    ...normalizeUsageMetrics({}), resultCount: null,
  };
  let ended = false;
  function deliver(value: UsageStart | UsageFinish) {
    if (!sink) return;
    try { const safe = parseUsageAttempt(value); void (safe.outcome === "running" ? sink.recordStart(safe) : sink.recordFinish(safe)).catch(() => {}); } catch { /* Best effort; never expose the request or response. */ }
  }
  deliver(state);
  return {
    update(metrics: UsageMetrics) { if (ended) return; state = { ...state, ...metrics, revision: state.revision + 1 }; deliver(state); },
    finish(outcome: UsageFinish["outcome"], errorCode: string | null = null, resultCount: number | null = null) {
      if (ended) return; ended = true;
      const finishedAt = new Date().toISOString();
      deliver({ ...state, revision: state.revision + 1, outcome, errorCode, resultCount, finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(state.startedAt)) });
    },
  };
}
const counter = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const object = (value: unknown): Record<string, any> => typeof value === "object" && value !== null ? value as Record<string, any> : {};

/** Inline, bounded SSE observation. No clone, tee, extra consumer, or persisted body. */
export function createLlmUsageTransport(snapshot: LlmRuntimeSnapshot, signal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch) {
  const attempts: ReturnType<typeof startUsageAttempt>[] = [];
  const cleanups: (() => void)[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // SDK-owned signals and iterator cleanup also fire on protocol errors.
    // Only the original caller signal establishes an actual cancellation.
    const abort = signal;
    if (abort?.aborted || init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const attempt = startUsageAttempt(snapshot, "llm"); attempts.push(attempt);
    const onAbort = () => attempt.finish("cancelled", "cancelled");
    abort?.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => abort?.removeEventListener("abort", onAbort));
    try {
      const response = await fetcher(input, init);
      if (!response.ok) { attempt.finish("failed", `http_${response.status}`); return response; }
      if (!response.body) return response;
      let raw: Record<string, number> = {};
      function observe(value: unknown) {
        const event = object(value);
        const usage = object(event.usage ?? object(event.message).usage ?? object(event.choices?.[0]).usage);
        const keys = snapshot.protocol === "anthropic_messages"
          ? ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
          : ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_cache_hit_tokens", "cached_tokens"];
        for (const key of keys) { const count = counter(usage[key]); if (count !== undefined) raw[key] = count; }
        const cached = counter(object(usage.prompt_tokens_details).cached_tokens);
        if (cached !== undefined) raw.cached_tokens = cached;
        const written = counter(object(usage.prompt_tokens_details).cache_write_tokens);
        if (written !== undefined) raw.cache_write_tokens = written;
        try {
          let metrics: UsageMetrics;
          if (snapshot.protocol === "anthropic_messages") {
            // Anthropic input_tokens excludes both cache subsets. Missing subsets
            // remain unknown; only compute inclusive input when all are explicit.
            const inclusive = raw.input_tokens !== undefined && raw.cache_read_input_tokens !== undefined && raw.cache_creation_input_tokens !== undefined
              ? raw.input_tokens + raw.cache_read_input_tokens + raw.cache_creation_input_tokens : undefined;
            metrics = normalizeUsageMetrics({ inputTokens: inclusive ?? null, outputTokens: raw.output_tokens ?? null, cacheReadTokens: raw.cache_read_input_tokens ?? null, cacheWriteTokens: raw.cache_creation_input_tokens ?? null });
          } else metrics = normalizeUsageMetrics({ inputTokens: raw.prompt_tokens ?? null, outputTokens: raw.completion_tokens ?? null, totalTokens: raw.total_tokens ?? null, cacheReadTokens: raw.cached_tokens ?? raw.prompt_cache_hit_tokens ?? null, cacheWriteTokens: raw.cache_write_tokens ?? null });
          if (Object.keys(usage).length) attempt.update(metrics);
        } catch { /* Malformed provider counters remain unknown, not guessed. */ }
      }
      let line = ""; let discard = false;
      const decoder = new TextDecoder();
      function consume(text: string) {
        for (const character of text) {
          if (character === "\n") {
            if (!discard && line.startsWith("data:")) { try { observe(JSON.parse(line.slice(5).trim())); } catch { /* Not a JSON usage event. */ } }
            line = ""; discard = false;
          } else if (!discard) { if (line.length < 65536) line += character; else { line = ""; discard = true; } }
        }
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try { const result = await reader.read(); if (result.done) { consume(decoder.decode() + "\n"); controller.close(); } else { consume(decoder.decode(result.value, { stream: true })); controller.enqueue(result.value); } }
          catch (error) { attempt.finish(abort?.aborted ? "cancelled" : "failed", abort?.aborted ? "cancelled" : "stream_failed"); controller.error(error); }
        },
        async cancel(reason) { if (abort?.aborted) attempt.finish("cancelled", "cancelled"); await reader.cancel(reason); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { attempt.finish(abort?.aborted ? "cancelled" : "failed", abort?.aborted ? "cancelled" : "network_failed"); throw error; }
  };
  return { fetch, finish(stopReason: string) {
    for (const cleanup of cleanups) cleanup();
    const cancelled = signal?.aborted === true;
    const failed = stopReason === "error" || stopReason === "aborted";
    for (const attempt of attempts) attempt.finish(cancelled ? "cancelled" : failed ? "failed" : "succeeded", cancelled ? "cancelled" : failed ? "provider_failed" : null);
  } };
}
