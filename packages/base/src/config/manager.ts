import type { Static, TSchema } from "typebox";
import { ConfigError } from "./config-error.js";
import { defineConfig, sameDefinition, type ConfigDefinition } from "./definition.js";
import type { ConfigRuntime, ConfigRuntimeOptions } from "./ports.js";
import { ConfigRecordCore, portCall, type ConfigRecord } from "./record.js";
import { createProfileCollection } from "./profiles.js";
import type { ConfigHandle, ProfileCollection } from "./types.js";

export function createConfigRuntime(options: ConfigRuntimeOptions): ConfigRuntime {
  return {
    createScope(scope) {
      let disposed = false;
      const bindings = new Map<string, { definition: ConfigDefinition; kind: "config" | "profiles"; handle: ConfigHandle<unknown> | ProfileCollection<unknown> }>();
      const assertActive = () => { if (disposed) throw new ConfigError("disposed", { scope }); };
      return {
        dispose() { disposed = true; },
        service: {
          version: 1,
          bind<S extends TSchema>(input: ConfigDefinition<S>): ConfigHandle<Static<S>> {
            assertActive();
            const definition = defineConfig(input);
            const existing = bindings.get(definition.key);
            if (existing) {
              if (existing.kind !== "config" || !sameDefinition(existing.definition, definition)) throw new ConfigError("definition_conflict", { scope, key: definition.key });
              return existing.handle as ConfigHandle<Static<S>>;
            }
            const address = { scope, key: definition.key };
            const core = new ConfigRecordCore(definition, address, options);
            let initial: ConfigRecord | undefined;
            function write(record: ConfigRecord) {
              portCall("write_document", core.context, () => options.documents.write({ ...address }, core.document(record)));
            }
            function load(persistMigration = true): { record: ConfigRecord; persisted: boolean; migrated: boolean } {
              assertActive();
              const document = portCall("read_document", core.context, () => options.documents.read({ ...address }));
              if (document === undefined) return { record: initial ??= core.initial(), persisted: false, migrated: false };
              const { record, migrated } = core.loadDocument(document);
              if (migrated && persistMigration) write(record);
              return { record, persisted: true, migrated };
            }
            const handle: ConfigHandle<Static<S>> = {
              async getView() { return core.view(load().record); },
              async save(draft) {
                const { record, persisted, migrated } = load(false);
                const next = core.prepareSave(record, draft, persisted);
                if (next.changed || migrated) { core.writeSecrets(next.secretWrites); write(next.record); }
                return core.view(next.record);
              },
              async resolveSnapshot() { return core.snapshot(load().record); },
              async resolveDraft(draft) { return core.snapshot(load(false).record, draft); },
            };
            bindings.set(definition.key, { definition, kind: "config", handle });
            return handle;
          },
          bindProfiles<S extends TSchema>(input: ConfigDefinition<S>): ProfileCollection<Static<S>> {
            assertActive();
            const definition = defineConfig(input);
            const existing = bindings.get(definition.key);
            if (existing) {
              if (existing.kind !== "profiles" || !sameDefinition(existing.definition, definition)) throw new ConfigError("definition_conflict", { scope, key: definition.key });
              return existing.handle as ProfileCollection<Static<S>>;
            }
            const handle = createProfileCollection<Static<S>>(definition, { scope, key: definition.key }, options, assertActive);
            bindings.set(definition.key, { definition, kind: "profiles", handle });
            return handle;
          },
        },
      };
    },
  };
}
