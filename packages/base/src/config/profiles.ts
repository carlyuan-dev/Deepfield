import type { ConfigDefinition } from "./definition.js";
import { cloneObject, isObject } from "./definition.js";
import { ConfigError } from "./config-error.js";
import type { ConfigAddress, ConfigRuntimeOptions } from "./ports.js";
import { ConfigRecordCore, portCall, type ConfigRecord, type ConfigRecordValuePolicy } from "./record.js";
import type { ConfigDraft, ProfileCollection, ProfileDraft, ProfilesView, ProfileSnapshot } from "./types.js";

type ProfileRecord = ConfigRecord & { id: string; name: string };
type ProfileState = { activeProfileId: string | null; profiles: ProfileRecord[] };
type ProfilesDocument = ProfileState & { formatVersion: 1; kind: "profiles"; schemaVersion: number };
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const validName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 120;

/** Used only by a trusted legacy document adapter, never exposed by the scoped service. */
type ProfileCollectionCompatibility = ConfigRecordValuePolicy & { deleteSecretsBeforeWrite: boolean };

/** Collection metadata surrounds the same record core used by ordinary configuration. */
export function createProfileCollection<V>(
  definition: ConfigDefinition,
  address: ConfigAddress,
  options: ConfigRuntimeOptions,
  assertActive: () => void,
  compatibility?: ProfileCollectionCompatibility,
): ProfileCollection<V> {
  const context = { ...address, schemaVersion: definition.schemaVersion };
  const core = (id?: string) => new ConfigRecordCore(definition, address, options, id, compatibility);
  function write(state: ProfileState): void {
    const document: ProfilesDocument = { formatVersion: 1, kind: "profiles", schemaVersion: definition.schemaVersion, ...state };
    portCall("write_document", context, () => options.documents.write({ ...address },
      compatibility ? compatibility.cloneValues(document) : cloneObject(document, context)));
  }
  function load(persistMigration = true): { state: ProfileState; migrated: boolean } {
    assertActive();
    const input = portCall("read_document", context, () => options.documents.read({ ...address }));
    if (input === undefined) return { state: { activeProfileId: null, profiles: [] }, migrated: false };
    if (!isObject(input) || input.formatVersion !== 1 || input.kind !== "profiles"
      || !Number.isSafeInteger(input.schemaVersion) || (input.schemaVersion as number) < 1
      || !(input.activeProfileId === null || validId(input.activeProfileId)) || !Array.isArray(input.profiles)
      || Object.keys(input).some((key) => !["formatVersion", "kind", "schemaVersion", "activeProfileId", "profiles"].includes(key))) {
      throw new ConfigError("invalid_document", context);
    }
    const version = input.schemaVersion as number;
    if (version > definition.schemaVersion) throw new ConfigError("unsupported_version", { ...context, storedVersion: version });
    // Even an empty collection must not silently skip missing migration declarations.
    for (let step = version; step < definition.schemaVersion; step++) {
      if (!definition.migrations?.[step]) throw new ConfigError("missing_migration", { ...context, storedVersion: step });
    }
    const ids = new Set<string>();
    const profiles = input.profiles.map((entry: unknown): ProfileRecord => {
      if (!isObject(entry) || !validId(entry.id) || !validName(entry.name) || ids.has(entry.id)
        || Object.keys(entry).some((key) => !["id", "name", "values", "credentialRefs", "revision"].includes(key))) {
        throw new ConfigError("invalid_document", context);
      }
      ids.add(entry.id);
      const { record } = core(entry.id).loadDocument({ formatVersion: 1, kind: "config", schemaVersion: version,
        values: entry.values, credentialRefs: entry.credentialRefs, revision: entry.revision });
      return { id: entry.id, name: entry.name, ...record };
    });
    if (input.activeProfileId !== null && !ids.has(input.activeProfileId)) throw new ConfigError("invalid_document", context);
    const state = { activeProfileId: input.activeProfileId, profiles };
    const migrated = version !== definition.schemaVersion;
    if (migrated && persistMigration) write(state);
    return { state, migrated };
  }
  function view(state: ProfileState): ProfilesView<V> {
    return { activeProfileId: state.activeProfileId, profiles: state.profiles.map((record) => ({ id: record.id, name: record.name, ...core(record.id).view<V>(record) })) };
  }
  function find(state: ProfileState, id: string): ProfileRecord {
    const record = state.profiles.find((entry) => entry.id === id);
    if (!record) throw new ConfigError("profile_not_found", { ...context, profileId: id });
    return record;
  }
  function draftRecord(draft: ProfileDraft<V>): ConfigDraft<V> {
    if (!isObject(draft) || !validName(draft.name) || (draft.id !== undefined && !validId(draft.id))
      || Object.keys(draft).some((key) => !["id", "name", "values", "secrets"].includes(key))) throw new ConfigError("invalid_values", context);
    return { values: draft.values, ...(draft.secrets === undefined ? {} : { secrets: draft.secrets }) };
  }
  function snapshot(record: ProfileRecord, draft?: ConfigDraft<V>): ProfileSnapshot<V> {
    return { ...core(record.id).snapshot<V>(record, draft), profile: { id: record.id, name: record.name } };
  }
  return {
    async getView() { return view(load().state); },
    async save(draft) {
      const { state, migrated } = load(false);
      const values = draftRecord(draft);
      const existing = draft.id === undefined ? undefined : find(state, draft.id);
      const id = existing?.id ?? core().newId();
      if (!validId(id) || (!existing && state.profiles.some((record) => record.id === id))) throw new ConfigError("invalid_document", context);
      const recordCore = core(id);
      const next = recordCore.prepareSave(existing ?? recordCore.initial(), values, existing !== undefined);
      const renamed = existing !== undefined && existing.name !== draft.name;
      const record = { ...next.record, id, name: draft.name };
      if (renamed && !next.changed) record.revision = recordCore.newId();
      if (existing) state.profiles[state.profiles.indexOf(existing)] = record;
      else state.profiles.push(record);
      if (next.changed || renamed || migrated) { recordCore.writeSecrets(next.secretWrites); write(state); }
      return view(state);
    },
    async activate(id) {
      const { state, migrated } = load(false);
      if (id !== null) find(state, id);
      if (state.activeProfileId !== id || migrated) { state.activeProfileId = id; write(state); }
      return view(state);
    },
    async delete(id) {
      const { state } = load(false);
      const record = find(state, id);
      if (state.activeProfileId === id) throw new ConfigError("active_profile", { ...context, profileId: id });
      state.profiles = state.profiles.filter((entry) => entry.id !== id);
      const deleteSecrets = () => {
        for (const ref of Object.values(record.credentialRefs)) portCall("delete_secret", { ...context, profileId: id }, () => options.secrets.delete(ref));
      };
      if (compatibility?.deleteSecretsBeforeWrite) deleteSecrets();
      write(state);
      if (!compatibility?.deleteSecretsBeforeWrite) deleteSecrets();
      return view(state);
    },
    async resolveActive() {
      const { state } = load();
      if (state.activeProfileId === null) throw new ConfigError("no_active_profile", context);
      return snapshot(find(state, state.activeProfileId));
    },
    async resolveDraft(draft) {
      const { state } = load(false);
      const values = draftRecord(draft);
      const id = draft.id ?? core().newId();
      const existing = state.profiles.find((entry) => entry.id === id);
      return snapshot({ ...(existing ?? core(id).initial()), id, name: draft.name }, values);
    },
  };
}
