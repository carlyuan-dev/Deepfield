import type { ModelDiagnostic } from "./contracts.js";

/** Consume at most 8 KiB from a clone; the SDK retains the original response. */
export async function readModelErrorPrefix(response: Response, signal?: AbortSignal): Promise<string> {
  const reader = response.clone().body?.getReader();
  if (!reader) return "";
  const bytes = new Uint8Array(8192);
  let used = 0;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("diagnostic read aborted"));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (used < bytes.length) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      const part = value.subarray(0, bytes.length - used);
      bytes.set(part, used);
      used += part.length;
    }
  } catch {
    // A partial/unreadable body must not hide the known HTTP failure.
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    // A tee cancellation waits for its sibling; never await it before the SDK reads.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, used));
}

export function classifyModelHttpDiagnostic(httpStatus: number, prefix: string, requestedToolNames: readonly string[]): ModelDiagnostic {
  try {
    const body: unknown = JSON.parse(prefix);
    if (typeof body === "object" && body !== null) {
      const value = body as { error?: { message?: unknown }; message?: unknown };
      const message = value.error?.message ?? value.message;
      if (typeof message === "string") prefix = message;
    }
  } catch { /* Truncated JSON or plain-text errors are still bounded evidence. */ }
  const missingRootType = /tools\[(\d+)\]\.function\.parameters:\s*missing field [`'"]type[`'"]/i.exec(prefix);
  let reason: ModelDiagnostic["reason"] = "unknown";
  if (httpStatus === 401 || httpStatus === 403) reason = "auth";
  else if (httpStatus === 429) reason = "rate_limit";
  else if (/context[_ ]?(?:length|window)|maximum context|too many tokens|prompt is too long/i.test(prefix)) reason = "context";
  else if (missingRootType || /invalid schema for (?:function|tool)|(?:tool|function)[\s\S]{0,100}(?:invalid|unsupported)[\s\S]{0,30}schema/i.test(prefix)) reason = "invalid_tool_schema";
  const diagnostic: ModelDiagnostic = { httpStatus, reason };
  if (reason === "invalid_tool_schema") {
    const named = /(?:function|tool)\s+['"]([^'"]+)['"]/i.exec(prefix)?.[1];
    const index = missingRootType ? Number(missingRootType[1]) : named !== undefined && requestedToolNames.filter(name => name === named).length === 1 ? requestedToolNames.indexOf(named) : -1;
    if (Number.isSafeInteger(index) && index >= 0 && index < requestedToolNames.length) diagnostic.toolIndex = index;
    if (/schema must be a JSON Schema of ['"]type:\s*object['"]|(?:root|top[- ]level)\s+(?:schema\s+)?(?:type\s+)?(?:must|should)\s+be\s+(?:an?\s+)?object/i.test(prefix)) diagnostic.rootObjectRequired = true;
  }
  return diagnostic;
}
