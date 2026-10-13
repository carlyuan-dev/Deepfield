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
export type ProfileDraft<V> = ConfigDraft<V> & { id?: string; name: string };
export type ProfilesView<V> = { activeProfileId: string | null; profiles: (ConfigView<V> & { id: string; name: string })[] };
export type ProfileSnapshot<V> = ConfigSnapshot<V> & { profile: { id: string; name: string } };
export interface ProfileCollection<V> {
  getView(): Promise<ProfilesView<V>>;
  save(draft: ProfileDraft<V>): Promise<ProfilesView<V>>;
  activate(id: string | null): Promise<ProfilesView<V>>;
  delete(id: string): Promise<ProfilesView<V>>;
  resolveActive(): Promise<ProfileSnapshot<V>>;
  resolveDraft(draft: ProfileDraft<V>): Promise<ProfileSnapshot<V>>;
}
export interface ScopedConfigService {
  readonly version: 1;
  bind<S extends TSchema>(definition: ConfigDefinition<S>): ConfigHandle<Static<S>>;
  bindProfiles<S extends TSchema>(definition: ConfigDefinition<S>): ProfileCollection<Static<S>>;
}
