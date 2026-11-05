import { randomUUID } from "node:crypto";
import { currentTrace } from "./runtime.js";
import type { TraceScope } from "./index.js";
import { parseTraceContent, TRACE_CONTENT_MAX_BYTES, type TraceContentMode, type TraceContentRecord, type TraceContentPort, type TraceContentDraft, type TraceContentCaptureOptions, type TraceContentJson } from "./content.js";

let port: TraceContentPort | undefined;
export function configureTraceContent(value: TraceContentPort | undefined): void { port = value; }
export function captureTraceContent(draft: TraceContentDraft, body: () => unknown, options?: TraceContentCaptureOptions, scope = currentTrace()): void {
  try { if (port && scope) port.capture(scope, draft, body, options); } catch { /* Optional observation never changes business execution. */ }
}

/** One explicit authorization per request/root. Links and conversations grant nothing. */
export function createTraceContentCollector(sink: (serialized: string) => unknown, options: {
  maxPendingBytes?: number; maxBodyBytes?: number; timeoutMs?: number; now?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  const grants = new Map<string, { rootTraceId: string; mode: TraceContentMode; expires: number; secrets: readonly string[] }>();
  const queue: string[] = [];
  const maxBody = Math.max(64, Math.min(TRACE_CONTENT_MAX_BYTES, options.maxBodyBytes ?? TRACE_CONTENT_MAX_BYTES));
  const maxPending = Math.max(0, options.maxPendingBytes ?? 4 * 1024 * 1024);
  const secretSize = (values: readonly string[]) => values.reduce((total, value) => total + Buffer.byteLength(value), 0);
  const totalSecretSize = () => [...grants.values()].reduce((total, grant) => total + secretSize(grant.secrets), 0);
  let bytes = 0; let active = false; let closing = false; let closed = false;
  const health = { dropped: 0, failed: 0, pendingBytes: 0, lastErrorCode: null as null | "queue_full" | "sink_failed" | "closed" | "invalid_record" };
  let draining: Promise<void> = Promise.resolve();
  const expiry = setInterval(() => { for (const [id, grant] of grants) if (grant.expires <= now()) grants.delete(id); }, 60_000);
  expiry.unref();
  async function drain() {
    active = true;
    try {
      while (queue.length && !closed) {
        const item = queue[0]!;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timeout = false;
        try {
          const result = await Promise.race([Promise.resolve().then(() => sink(item)), new Promise<never>((_, reject) => { timer = setTimeout(() => { timeout = true; reject(new Error("timeout")); }, options.timeoutMs ?? 750); })]);
          if (result === false) throw new Error("rejected");
        } catch { health.failed++; health.lastErrorCode = "sink_failed"; }
        finally { if (timer) clearTimeout(timer); }
        if (closed) return;
        if (timeout) { closed = true; health.dropped += queue.length; queue.length = 0; bytes = 0; grants.clear(); clearInterval(expiry); }
        else { queue.shift(); bytes -= Buffer.byteLength(item); }
        health.pendingBytes = bytes;
      }
    } finally { active = false; }
  }
  return {
    authorize(requestId: string, rootTraceId: string, mode: TraceContentMode, secrets: readonly string[] = []): boolean {
      if (closing || closed || !["benchmark", "diagnostic"].includes(mode) || !/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]{0,199}$/.test(requestId) || !/^[A-Za-z0-9][A-Za-z0-9_.:@+~-]{0,199}$/.test(rootTraceId)) return false;
      for (const [key, grant] of grants) if (grant.expires <= now()) grants.delete(key);
      const old = grants.get(requestId);
      if (old) return old.rootTraceId === rootTraceId && old.mode === mode;
      if (grants.size >= 1000 || secrets.length > 100 || secrets.some(s => typeof s !== "string" || s.length > 16384)) return false;
      if (secretSize(secrets) > 65536 || totalSecretSize() + secretSize(secrets) > 4 * 1024 * 1024) return false;
      grants.set(requestId, { rootTraceId, mode, expires: now() + 3600_000, secrets: [...secrets].filter(Boolean) }); return true;
    },
    revoke(requestId: string) { grants.delete(requestId); },
    mode(requestId: string, rootTraceId: string): TraceContentMode | undefined {
      const grant = grants.get(requestId); return !closing && !closed && grant?.rootTraceId === rootTraceId && grant.expires > now() ? grant.mode : undefined;
    },
    capture(scope: TraceScope, draft: TraceContentDraft, body: () => unknown, capture: TraceContentCaptureOptions = {}) {
      const grant = grants.get(scope.requestId);
      if (closing || closed || !grant || grant.rootTraceId !== scope.rootTraceId || grant.expires <= now()) return;
      if (bytes >= maxPending) { health.dropped++; health.lastErrorCode = "queue_full"; return; }
      const record: TraceContentRecord = { ...scope, ...draft, version: 1, contentId: randomUUID(), capturedAt: new Date(now()).toISOString(), captureMode: grant.mode, completeness: "complete", redacted: false, byteLength: 0, reasonCode: "none" };
      try {
        let value = body();
        if (capture.jsonString) {
          if (typeof value !== "string") { record.reasonCode = "unsupported_body"; throw new Error(); }
          if (value.length > 4 * 1024 * 1024) { record.reasonCode = "input_too_large"; throw new Error(); }
          value = JSON.parse(value);
        }
        let visited = 0; let chars = 0;
        const seen = new Set<object>();
        if ((capture.secrets?.length ?? 0) > 100 || capture.secrets?.some(s => typeof s !== "string" || s.length > 16384)) throw new Error();
        const secrets = [...new Set([...grant.secrets, ...(capture.secrets ?? [])].filter(Boolean))].sort((a, b) => b.length - a.length);
        if (secrets.length > 100) throw new Error();
        if (secretSize(secrets) > 65536 || totalSecretSize() - secretSize(grant.secrets) + secretSize(secrets) > 4 * 1024 * 1024) throw new Error();
        // Trusted runtime keys remain request-scoped so subsequent tool output is protected too.
        grant.secrets = secrets;
        function clean(value: unknown, depth: number): TraceContentJson {
          if (++visited > 100000 || depth > 64) throw new Error();
          if (typeof value === "string") {
            chars += value.length; if (chars > 4 * 1024 * 1024) { record.reasonCode = "input_too_large"; throw new Error(); }
            let result = value;
            for (const secret of secrets) if (result.includes(secret)) { result = result.split(secret).join("[REDACTED]"); record.redacted = true; }
            return result;
          }
          if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
          if (!value || typeof value !== "object" || seen.has(value)) throw new Error();
          if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error();
          seen.add(value);
          const result: Record<string, TraceContentJson> = Object.create(null);
          const array: TraceContentJson[] = [];
          for (const key of Object.keys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!('value' in descriptor)) throw new Error();
            const safeKey = clean(key, depth + 1) as string;
            const sensitive = /^(?:api[-_]?key|authorization|proxy[-_]?authorization|password|passwd|secret|access[-_]?token|refresh[-_]?token|cookie|set[-_]?cookie)$/i.test(key);
            const child = sensitive ? (record.redacted = true, "[REDACTED]") : clean(descriptor.value, depth + 1);
            if (Array.isArray(value)) array.push(child); else result[safeKey] = child;
          }
          seen.delete(value); return Array.isArray(value) ? array : result;
        }
        const safe = clean(value, 0);
        const serialized = JSON.stringify(safe);
        if (Buffer.byteLength(serialized) <= maxBody) record.body = safe;
        else {
          // A JSON string containing a prefix of already-redacted JSON is explicitly truncated.
          let prefix = serialized.slice(0, Math.floor(maxBody / 6) - 2);
          if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
          record.body = prefix; record.completeness = "truncated"; record.reasonCode = "size_limit";
        }
        if (capture.incomplete) { record.completeness = "truncated"; record.reasonCode = capture.incomplete; }
        record.byteLength = Buffer.byteLength(JSON.stringify(record.body));
      } catch {
        delete record.body; record.byteLength = 0; record.completeness = "unavailable";
        if (record.reasonCode === "none") record.reasonCode = capture.incomplete ?? "serialization_failed";
      }
      try {
        const serialized = JSON.stringify(record); parseTraceContent(serialized);
        const size = Buffer.byteLength(serialized);
        if (bytes + size > maxPending) { health.dropped++; health.lastErrorCode = "queue_full"; return; }
        queue.push(serialized); bytes += size; health.pendingBytes = bytes;
        if (!active) draining = drain();
      } catch { health.dropped++; health.lastErrorCode = "invalid_record"; }
    },
    health: () => ({ ...health }),
    async close(timeoutMs = 1500) {
      closing = true;
      grants.clear(); clearInterval(expiry);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([draining, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); })]); }
      finally { if (timer) clearTimeout(timer); closed = true; grants.clear(); }
      if (queue.length) { health.dropped += queue.length; queue.length = 0; bytes = 0; health.pendingBytes = 0; health.lastErrorCode = "closed"; }
    },
  };
}
