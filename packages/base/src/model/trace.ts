import { randomUUID } from "node:crypto";
import { currentTrace, startTraceSpan, withTrace } from "../trace/runtime.js";
import type { TraceReferences } from "../trace/index.js";

type References = Pick<TraceReferences, "turn" | "phase"> & { requestId?: string };
type Result = { stopReason: string };
type Stream = { result(): Promise<Result> };
type StreamFunction = (...args: any[]) => Stream | Promise<Stream>;
const underlying = new WeakMap<StreamFunction, { source: StreamFunction; references: References }>();
const invocation = Symbol("deepfield.model.trace.invocation");

function begin(references: References) {
  const parent = currentTrace();
  const requestId = references.requestId ?? parent?.requestId;
  if (!requestId) return undefined;
  const modelRequestId = randomUUID();
  const { requestId: _, ...fields } = references;
  const span = startTraceSpan("model", requestId, { ...fields, modelRequestId }, parent);
  return { span, scope: { ...span.context, modelRequestId } };
}

/** Rewrapping adds caller metadata to the same boundary; it never adds a second span. */
export function traceModelStream<F extends StreamFunction>(stream: F, references: References = {}): F {
  const previous = underlying.get(stream);
  const source = previous?.source ?? stream;
  const fields = { ...previous?.references, ...references };
  const wrapped = ((...args: Parameters<F>) => {
    const inherited = args[2]?.[invocation] as { spanId: string; active: boolean } | undefined;
    if (inherited?.active && currentTrace()?.spanId === inherited.spanId) return source(...args);
    const trace = begin(fields);
    if (!trace) return source(...args);
    const signal = args[2]?.signal as AbortSignal | undefined;
    const marker = { spanId: trace.scope.spanId, active: true };
    // Private call-local metadata survives transparent options forwarding, but
    // cannot enter JSON payloads. Never mutate a caller-owned options object.
    args[2] = { ...args[2], [invocation]: marker };
    const fail = () => { marker.active = false; trace.span.end(signal?.aborted ? "cancelled" : "failed", "execution_failed"); };
    const observe = (result: Stream) => {
      const finished = result.result().then(message => {
        marker.active = false;
        trace.span.end(signal?.aborted ? "cancelled" : ["error", "aborted"].includes(message.stopReason) ? "failed" : "succeeded");
        return message;
      }, error => { fail(); throw error; });
      result.result = () => finished;
      void finished.catch(() => undefined);
      return result;
    };
    return withTrace(trace.scope, () => {
      try {
        const result = source(...args);
        return result instanceof Promise ? result.then(observe, error => { fail(); throw error; }) : observe(result);
      } catch (error) { fail(); throw error; }
    });
  }) as F;
  underlying.set(wrapped, { source, references: fields });
  return wrapped;
}

export async function traceModelCompletion<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const trace = begin({ phase: "completion" });
  if (!trace) return work();
  return withTrace(trace.scope, async () => {
    try { const value = await work(); trace.span.end("succeeded"); return value; }
    catch (error) { trace.span.end(signal?.aborted ? "cancelled" : "failed", "execution_failed"); throw error; }
  });
}
