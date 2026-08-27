export const SUMMARY_MAX_DEPTH = 8;
export const SUMMARY_MAX_NODES = 256;
export const SUMMARY_MAX_STRING_BYTES = 4096;
export const SUMMARY_MAX_BYTES = 16_384;

// Case-insensitive forbidden key names plus prototype-pollution keys. The
// whole summary is rejected when any of these appears as a field name; string
// VALUES containing similar words are allowed (field names and structure are
// what is forbidden, never innocent values).
const FORBIDDEN_KEYS = new Set([
  "body",
  "html",
  "pdf",
  "text",
  "apikey",
  "authorization",
  "cookie",
  "cause",
  "stack",
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Sanitizes an untrusted summary into a JSON string, or undefined when the
 * summary is absent or fails any guard (forbidden key, accessor, symbol,
 * exotic object, cycle, non-JSON value, depth/node limits, or UTF-8 byte
 * limits). The caller's object is never stringified directly: only the
 * validated copy is. All limits count UTF-8 bytes, never UTF-16 code units.
 */
export function sanitizeSummary(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const state = { nodes: 0 };
  const copy = sanitizeNode(value, 0, state, new Set<object>());
  if (copy === undefined) {
    return undefined;
  }
  const serialized = JSON.stringify(copy);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > SUMMARY_MAX_BYTES) {
    return undefined;
  }
  return serialized;
}

function sanitizeNode(
  value: unknown,
  depth: number,
  state: { nodes: number },
  ancestors: Set<object>,
): unknown {
  if (depth > SUMMARY_MAX_DEPTH) {
    return undefined;
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8") <= SUMMARY_MAX_STRING_BYTES ? value : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "object") {
    return undefined; // undefined / function / symbol / bigint
  }
  if (ancestors.has(value)) {
    return undefined; // cycle
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return undefined; // Date / Map / Set / class instance / exotic
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return undefined; // symbol keys are not JSON
  }
  state.nodes += 1;
  if (state.nodes > SUMMARY_MAX_NODES) {
    return undefined;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const copied = sanitizeNode(item, depth + 1, state, ancestors);
      if (copied === undefined && item !== null) {
        ancestors.delete(value);
        return undefined;
      }
      result.push(copied);
    }
    ancestors.delete(value);
    return result;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      continue;
    }
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      ancestors.delete(value);
      return undefined; // accessor: reading could execute code
    }
    if (!descriptor.enumerable) {
      continue;
    }
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      ancestors.delete(value);
      return undefined;
    }
    const copied = sanitizeNode(descriptor.value, depth + 1, state, ancestors);
    if (copied === undefined && descriptor.value !== null) {
      ancestors.delete(value);
      return undefined;
    }
    Object.defineProperty(result, key, {
      value: copied,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  ancestors.delete(value);
  return result;
}
