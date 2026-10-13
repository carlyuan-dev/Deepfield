import type { TSchema } from "typebox";
import { ConfigError, type ConfigErrorContext } from "./config-error.js";
import { checkValues, cloneObject, equalJson, isObject, type ConfigDefinition } from "./definition.js";
import type { ConfigAddress, ConfigRuntimeOptions } from "./ports.js";
import type { ConfigDraft, ConfigSnapshot, ConfigView, JsonObject } from "./types.js";

/** Shared record payload, independent of an ordinary document or a profile collection. */
export type ConfigRecord = { values: JsonObject; credentialRefs: Record<string, string>; revision: string };
export type ConfigDocument = ConfigRecord & { formatVersion: 1; kind: "config"; schemaVersion: number };

/** Internal adapter policy for legacy schemas whose value domain predates JSON-only records. */
export type ConfigRecordValuePolicy = {
  cloneValues(value: unknown): unknown;
  equalValues(left: unknown, right: unknown): boolean;
};

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function portCall<T>(operation: string, context: ConfigErrorContext, work: () => T): T {
  try { return work(); }
  catch (cause) { throw new ConfigError("storage_failed", { ...context, operation }, { cause }); }
}

export class ConfigRecordCore {
  readonly context: ConfigErrorContext;
  constructor(
    readonly definition: ConfigDefinition<TSchema>,
    readonly address: ConfigAddress,
    private readonly ports: ConfigRuntimeOptions,
    private readonly profileId?: string,
    private readonly valuePolicy?: ConfigRecordValuePolicy,
  ) {
    this.context = { ...address, schemaVersion: definition.schemaVersion,
      ...(profileId === undefined ? {} : { profileId }) };
  }

  newId(): string { return portCall("new_id", this.context, this.ports.newId); }

  private copyValues(value: unknown): JsonObject {
    if (!this.valuePolicy) return cloneObject(value, this.context);
    if (!isObject(value)) throw new ConfigError("invalid_values", this.context);
    try { return this.valuePolicy.cloneValues(value) as JsonObject; }
    catch (cause) { throw new ConfigError("invalid_values", this.context, { cause }); }
  }

  credentialRef(name: string): string {
    // Tuple encoding keeps scope, key, profile and credential boundaries unambiguous.
    return `config:${JSON.stringify([this.address.scope, this.address.key, this.profileId ?? null, name])}`;
  }

  values(input: unknown, fillDefaults: boolean): JsonObject {
    const values = this.copyValues(input);
    const normalized = fillDefaults ? { ...cloneObject(this.definition.defaults), ...values } : values;
    checkValues(this.definition.schema, normalized, this.context);
    return normalized;
  }

  initial(): ConfigRecord {
    return { values: this.values(this.definition.defaults, false), credentialRefs: {}, revision: this.newId() };
  }

  decodeRecord(input: unknown, validateValues = true): ConfigRecord {
    try {
      if (!isObject(input) || typeof input.revision !== "string" || !input.revision || !isObject(input.credentialRefs)) {
        throw new ConfigError("invalid_document", this.context);
      }
      const refs = cloneObject(input.credentialRefs, this.context);
      for (const [name, ref] of Object.entries(refs)) {
        if (!Object.hasOwn(this.definition.secrets ?? {}, name) || ref !== this.credentialRef(name)) {
          throw new ConfigError("invalid_document", this.context);
        }
      }
      return { values: validateValues ? this.values(input.values, false) : this.copyValues(input.values),
        credentialRefs: refs as Record<string, string>, revision: input.revision };
    } catch { throw new ConfigError("invalid_document", this.context); }
  }

  document(record: ConfigRecord): ConfigDocument {
    return { formatVersion: 1, kind: "config", schemaVersion: this.definition.schemaVersion,
      ...cloneObject(record, this.context) } as ConfigDocument;
  }

  loadDocument(input: unknown): { record: ConfigRecord; migrated: boolean } {
    if (!isObject(input) || input.formatVersion !== 1 || input.kind !== "config"
      || typeof input.schemaVersion !== "number" || !Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1
      || Object.keys(input).some((key) => !["formatVersion", "kind", "schemaVersion", "values", "credentialRefs", "revision"].includes(key))) {
      throw new ConfigError("invalid_document", this.context);
    }
    const version = input.schemaVersion;
    const context = { ...this.context, storedVersion: version };
    if (version > this.definition.schemaVersion) throw new ConfigError("unsupported_version", context);
    const record = this.decodeRecord(input, version === this.definition.schemaVersion);
    if (version === this.definition.schemaVersion) return { record, migrated: false };
    let values = record.values;
    for (let step = version; step < this.definition.schemaVersion; step++) {
      const migration = this.definition.migrations?.[step];
      if (!migration) throw new ConfigError("missing_migration", { ...context, storedVersion: step });
      try { values = cloneObject(migration(cloneObject(values)), context); }
      catch (cause) { throw new ConfigError("migration_failed", { ...context, storedVersion: step }, { cause }); }
    }
    try { values = this.values(values, false); }
    catch (cause) { throw new ConfigError("migration_failed", context, { cause }); }
    return { record: { ...record, values, revision: this.newId() }, migrated: true };
  }

  view<V>(record: ConfigRecord): ConfigView<V> {
    const statuses = Object.keys(this.definition.secrets ?? {}).map((name) => {
      const ref = own(record.credentialRefs, name);
      return [name, ref === undefined ? false : portCall("has_secret", this.context, () => this.ports.secrets.has(ref))];
    });
    return { values: this.copyValues(record.values) as V, secretStatus: Object.fromEntries(statuses) };
  }

  private draft<V>(draft: ConfigDraft<V>): { values: JsonObject; secrets: Record<string, string> } {
    if (!isObject(draft) || Object.keys(draft).some((key) => key !== "values" && key !== "secrets")) {
      throw new ConfigError("invalid_values", this.context);
    }
    const values = this.values(draft.values, true);
    let secrets: JsonObject;
    try { secrets = draft.secrets === undefined ? {} : cloneObject(draft.secrets, this.context); }
    catch { throw new ConfigError("invalid_secrets", this.context); }
    for (const [name, value] of Object.entries(secrets)) {
      if (!Object.hasOwn(this.definition.secrets ?? {}, name) || typeof value !== "string" || value.length === 0) {
        throw new ConfigError("invalid_secrets", this.context);
      }
    }
    return { values, secrets: secrets as Record<string, string> };
  }

  private getSecret(ref: string): string | undefined {
    return portCall("get_secret", this.context, () => this.ports.secrets.get(ref));
  }

  prepareSave<V>(current: ConfigRecord, draft: ConfigDraft<V>, persisted: boolean): {
    record: ConfigRecord; changed: boolean; secretWrites: { ref: string; value: string }[];
  } {
    const normalized = this.draft(draft);
    const credentialRefs = { ...current.credentialRefs };
    const secretWrites: { ref: string; value: string }[] = [];
    for (const [name, value] of Object.entries(normalized.secrets)) {
      const existingRef = own(credentialRefs, name);
      if (existingRef === undefined || this.getSecret(existingRef) !== value) {
        const ref = existingRef ?? this.credentialRef(name);
        Object.defineProperty(credentialRefs, name, { value: ref, writable: true, enumerable: true, configurable: true });
        secretWrites.push({ ref, value });
      }
    }
    const equalValues = this.valuePolicy?.equalValues ?? equalJson;
    const changed = !persisted || !equalValues(current.values, normalized.values) || secretWrites.length > 0;
    return { record: { values: normalized.values, credentialRefs, revision: changed ? this.newId() : current.revision },
      changed, secretWrites };
  }

  writeSecrets(writes: { ref: string; value: string }[]): void {
    for (const { ref, value } of writes) portCall("set_secret", this.context, () => this.ports.secrets.set(ref, value));
  }

  snapshot<V>(record: ConfigRecord, draft?: ConfigDraft<V>): ConfigSnapshot<V> {
    const normalized = draft === undefined ? undefined : this.draft(draft);
    const entries = Object.entries(this.definition.secrets ?? {}).flatMap(([name, declaration]) => {
      const ref = own(record.credentialRefs, name);
      const secret = (normalized === undefined ? undefined : own(normalized.secrets, name))
        ?? (ref === undefined ? undefined : this.getSecret(ref));
      if (!secret && declaration.requiredForExecution) throw new ConfigError("missing_secret", this.context);
      return secret === undefined ? [] : [[name, secret]];
    });
    return {
      values: this.copyValues(normalized?.values ?? record.values) as V,
      secrets: Object.fromEntries(entries),
      identity: { ...this.address, schemaVersion: this.definition.schemaVersion,
        revision: draft === undefined ? record.revision : this.newId(),
        ...(this.profileId === undefined ? {} : { profileId: this.profileId }),
        ...(draft === undefined ? {} : { draftSessionId: this.newId() }),
      },
    };
  }
}
