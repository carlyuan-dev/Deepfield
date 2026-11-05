import type { TraceCollector } from "@deepfield/base/trace";

/** Invoked by the message loop only after execution drain or its deadline. */
export function createWorkerTelemetryFlush(usage: { flush(): Promise<void> }, trace: Pick<TraceCollector, "close">): () => Promise<void> {
  return async () => { await Promise.all([usage.flush(), trace.close()]); };
}
