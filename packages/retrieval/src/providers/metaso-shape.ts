export type JsonShape =
  | "null"
  | "boolean"
  | "number"
  | "string"
  | { readonly type: "array"; readonly length: number; readonly first?: JsonShape }
  | { readonly type: "object"; readonly properties: Readonly<Record<string, JsonShape>> };

const MAX_DEPTH = 12;
const MAX_OBJECT_PROPERTIES = 100;
const MAX_ARRAY_LENGTH = 10000;

/** Fixed, value-free rejection: never carries input, cause or serialized values. */
class ShapeProbeError extends Error {
  constructor() {
    super("value-free shape probe rejected input");
    this.name = "ShapeProbeError";
  }
}

function fail(): never {
  throw new ShapeProbeError();
}

/** Canonical array index per spec: own enumerable array elements only. */
function isCanonicalArrayIndex(key: string): boolean {
  if (key === "0") {
    return true;
  }
  if (!/^[1-9][0-9]*$/.test(key)) {
    return false;
  }
  const numeric = Number(key);
  return Number.isInteger(numeric) && numeric < 4294967295;
}

function summarize(value: unknown, depth: number, seen: WeakSet<object>): JsonShape {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    fail();
  }
  // value is an object from here on
  if (depth > MAX_DEPTH) {
    fail();
  }
  if (seen.has(value)) {
    fail(); // cyclic OR repeated reference: never probe twice
  }
  seen.add(value);
  if (Object.hasOwn(value, "toJSON")) {
    fail(); // never invoked, never probed
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) {
      fail();
    }
    const ownNames = Object.getOwnPropertyNames(value); // present indices + "length"
    const enumerable = Object.keys(value);
    // reject symbol keys and any custom non-enumerable own field on the array
    if (Reflect.ownKeys(value).length !== ownNames.length) {
      fail();
    }
    const present = ownNames.filter((key) => key !== "length");
    // every own key besides "length" must be enumerable (no hidden custom fields)
    if (present.length !== enumerable.length) {
      fail();
    }
    for (const key of present) {
      // ONLY canonical array indices with own DATA descriptors are accepted:
      // accessor getters on ANY existing element and extra enumerable
      // properties (data or accessor) are rejected without ever running them
      if (!isCanonicalArrayIndex(key)) {
        fail();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || "value" in descriptor === false) {
        fail();
      }
    }
    if (value.length === 0) {
      return Object.freeze({ type: "array", length: 0 });
    }
    // inspect ONLY element zero (own data, guaranteed above); never a getter,
    // never a sparse hole; later holes stay allowed
    const firstDescriptor = Object.getOwnPropertyDescriptor(value, "0");
    if (firstDescriptor === undefined || "value" in firstDescriptor === false) {
      fail(); // sparse array with hole at index 0: stable rejection
    }
    const first = summarize(firstDescriptor.value, depth + 1, seen);
    return Object.freeze({ type: "array", length: value.length, first });
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(); // class instances / non-plain containers are rejected
  }
  const ownNames = Object.getOwnPropertyNames(value);
  const enumerable = Object.keys(value);
  if (Reflect.ownKeys(value).length !== ownNames.length || ownNames.length !== enumerable.length) {
    fail(); // symbol keys or non-enumerable custom fields
  }
  if (ownNames.length > MAX_OBJECT_PROPERTIES) {
    fail();
  }
  ownNames.sort();
  const properties = Object.create(null) as Record<string, JsonShape>;
  for (const key of ownNames) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || "value" in descriptor === false) {
      fail(); // accessor property: getter never runs
    }
    properties[key] = summarize(descriptor.value, depth + 1, seen);
  }
  Object.freeze(properties);
  return Object.freeze({ type: "object", properties });
}

/**
 * Value-free shape summarizer: keeps ONLY property names, value kinds and array
 * metadata. No string/number/boolean values, URLs, snippets or tokens survive;
 * no getter/toJSON ever runs; errors are fixed and never serialize the input.
 */
export function summarizeJsonShape(value: unknown): JsonShape {
  return summarize(value, 0, new WeakSet<object>());
}
