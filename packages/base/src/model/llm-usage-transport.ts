import type { LlmRuntimeSnapshot } from "../config/llm.js";
import { normalizeUsageMetrics } from "../usage/contracts.js";
import type { UsageMetrics, UsageAttemptHandle } from "../usage/contracts.js";
import type { ModelRuntimeOptions } from "./runtime.js";

const counter = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const object = (value: unknown): Record<string, any> => typeof value === "object" && value !== null ? value as Record<string, any> : {};

/** Inline, bounded SSE observation. No clone, tee, extra consumer, or persisted body. */
export function createLlmUsageTransport(runtime: ModelRuntimeOptions, snapshot: LlmRuntimeSnapshot, signal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch, onResponseBodyError?: (error: unknown) => void, requestIdentity?: () => { readonly requestId: string; readonly modelRequestId: string } | undefined) {
  const attempts: UsageAttemptHandle[] = [];
  const cleanups: (() => void)[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    // SDK-owned signals and iterator cleanup also fire on protocol errors.
    // Only the original caller signal establishes an actual cancellation.
    const abort = signal;
    if (abort?.aborted || init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const attempt = runtime.usage.startAttempt({
      ...(snapshot.draftSessionId ? { draftSessionId: snapshot.draftSessionId } : { profileId: snapshot.id }),
      profileName: snapshot.name, providerId: snapshot.provider, modelId: snapshot.modelId, serviceKind: "llm",
      ...(snapshot.configRevisionId !== undefined ? { configRevisionId: snapshot.configRevisionId } : {}),
    }, runtime.snapshotIdentity(snapshot)); attempts.push(attempt);
    const onAbort = () => attempt.finish("cancelled", "cancelled");
    abort?.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => abort?.removeEventListener("abort", onAbort));
    try {
      const pending = fetcher(input, init);
      // Internal correlation is best-effort, unlike the mandatory request observer.
      // Notify only after the actual fetch call; this is not a durable delivery acknowledgment.
      try { runtime.onRequestAttempt?.(Object.freeze({ ...requestIdentity?.(), operationId: attempt.operationId, attemptId: attempt.attemptId })); }
      catch { /* Optional diagnostic notification must not change the model/transport result. */ }
      const response = await pending;
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
          let result: ReadableStreamReadResult<Uint8Array>;
          try { result = await reader.read(); }
          catch (error) {
            if (!abort?.aborted) { try { onResponseBodyError?.(error); } catch { /* Diagnostics must not change body consumption. */ } }
            attempt.finish(abort?.aborted ? "cancelled" : "failed", abort?.aborted ? "cancelled" : "stream_failed");
            controller.error(error);
            return;
          }
          if (result.done) { consume(decoder.decode() + "\n"); controller.close(); } else { consume(decoder.decode(result.value, { stream: true })); controller.enqueue(result.value); }
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
