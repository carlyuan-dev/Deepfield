import type { Static, TSchema } from "typebox";
import type { ConfigDefinition } from "./definition.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type SecretDeclaration = { requiredForExecution: boolean };
export type ConfigDraft<V> = { values: V; secrets?: Record<string, string> };
export type ConfigView<V> = { values: V; secretStatus: Record<string, boolean> };
export type ConfigIdentity = {
  scope: string; key: string; schemaVersion: number; revision: string;
  profileId?: string; draftSessionId?: string;
};
export type ConfigSnapshot<V> = { values: V; secrets: Record<string, string>; identity: ConfigIdentity };
export interface ConfigHandle<V> {
  getView(): Promise<ConfigView<V>>;
  save(draft: ConfigDraft<V>): Promise<ConfigView<V>>;
  resolveSnapshot(): Promise<ConfigSnapshot<V>>;
  resolveDraft(draft: ConfigDraft<V>): Promise<ConfigSnapshot<V>>;
}
/** Task 2 adds the optional profile collection to this service. */
export interface ScopedConfigService {
  readonly version: 1;
  bind<S extends TSchema>(definition: ConfigDefinition<S>): ConfigHandle<Static<S>>;
}
