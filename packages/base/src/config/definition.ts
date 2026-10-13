import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { ConfigError, type ConfigErrorContext } from "./config-error.js";
import type { JsonObject, JsonValue, SecretDeclaration } from "./types.js";

export type ConfigDefinition<S extends TSchema = TSchema> = {
  key: string; schemaVersion: number; schema: S; defaults: Static<S>;
  secrets?: Readonly<Record<string, SecretDeclaration>>;
  migrations?: Readonly<Record<number, (values: JsonObject) => JsonObject>>;
};

export function isObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reject lossy JSON before cloning; never stringify untrusted values into errors. */
export function cloneJson(value: unknown, context: ConfigErrorContext = {}): JsonValue {
  const ancestors = new Set<object>();
  function copy(input: unknown): JsonValue {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input) && !Object.is(input, -0)) return input;
    if (typeof input !== "object" || input === null || ancestors.has(input)) throw new ConfigError("invalid_values", context);
    if (!Array.isArray(input) && !isObject(input)) throw new ConfigError("invalid_values", context);
    ancestors.add(input);
    const keys = Reflect.ownKeys(input);
    const array = Array.isArray(input);
    if (array && (keys.length !== input.length + 1 || !keys.includes("length"))) throw new ConfigError("invalid_values", context);
    const entries: [string, JsonValue][] = [];
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) throw new ConfigError("invalid_values", context);
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length)) throw new ConfigError("invalid_values", context);
      entries.push([key, copy(descriptor.value)]);
    }
    ancestors.delete(input);
    return array ? entries.map(([, item]) => item) : Object.fromEntries(entries);
  }
  return copy(value);
}

export function cloneObject(value: unknown, context: ConfigErrorContext = {}): JsonObject {
  if (!isObject(value)) throw new ConfigError("invalid_values", context);
  return cloneJson(value, context) as JsonObject;
}

/** Object insertion order is not configuration identity. */
export function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.keys(left), b = Object.keys(right);
  return a.length === b.length && a.every((key) => Object.hasOwn(right, key)
    && equalJson((left as JsonObject)[key]!, (right as JsonObject)[key]!));
}

export function checkValues(schema: TSchema, value: JsonObject, context: ConfigErrorContext): void {
  try {
    if (Value.Check(schema, value)) return;
  } catch {
    // TypeBox diagnostics can include input values; the public failure is controlled.
  }
  throw new ConfigError("invalid_values", context);
}

export function defineConfig<S extends TSchema>(input: ConfigDefinition<S>): ConfigDefinition<S> {
  const context = { key: typeof input?.key === "string" ? input.key : "" };
  try {
    if (!input || typeof input.key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.key)
      || !Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1
      || !isObject(input.schema) || input.schema.type !== "object") {
      throw new ConfigError("invalid_definition", context);
    }
    const schema = structuredClone(input.schema);
    // Check the effective schema after TypeBox's non-enumerable markers are removed.
    // Accepted metadata must also be comparable on a subsequent binding.
    cloneObject(schema, context);
    const defaults = cloneObject(input.defaults, context);
    checkValues(schema, defaults, context);
    const secrets = input.secrets === undefined ? undefined : cloneObject(input.secrets, context);
    if (secrets && Object.values(secrets).some((value) => !isObject(value)
      || Object.keys(value).length !== 1 || typeof value.requiredForExecution !== "boolean")) {
      throw new ConfigError("invalid_definition", context);
    }
    const migrations = input.migrations;
    if (migrations !== undefined && (!isObject(migrations) || Object.entries(migrations).some(([version, migration]) =>
      !/^[1-9]\d*$/.test(version) || !Number.isSafeInteger(Number(version))
      || Number(version) >= input.schemaVersion || typeof migration !== "function"))) {
      throw new ConfigError("invalid_definition", context);
    }
    return { key: input.key, schemaVersion: input.schemaVersion, schema, defaults: defaults as Static<S>,
      ...(secrets === undefined ? {} : { secrets: secrets as Record<string, SecretDeclaration> }),
      ...(migrations === undefined ? {} : { migrations: { ...migrations } }),
    };
  } catch {
    throw new ConfigError("invalid_definition", context);
  }
}

export function sameDefinition(a: ConfigDefinition, b: ConfigDefinition): boolean {
  // TypeBox object schemas are data. Unsupported schema metadata fails at definition binding.
  return a.schemaVersion === b.schemaVersion
    && equalJson(cloneJson(a.schema), cloneJson(b.schema))
    && equalJson(cloneJson(a.defaults), cloneJson(b.defaults))
    && equalJson(cloneJson(a.secrets ?? {}), cloneJson(b.secrets ?? {}))
    && Object.keys(a.migrations ?? {}).length === Object.keys(b.migrations ?? {}).length
    && Object.entries(a.migrations ?? {}).every(([version, fn]) => b.migrations?.[Number(version)] === fn);
}
