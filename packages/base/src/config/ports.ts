import type { ScopedConfigService } from "./types.js";

export type ConfigAddress = { scope: string; key: string };
export interface ConfigDocumentStore {
  read(address: ConfigAddress): unknown | undefined;
  write(address: ConfigAddress, document: unknown): void;
}
export interface ConfigSecretStore {
  has(ref: string): boolean;
  get(ref: string): string | undefined;
  set(ref: string, value: string): void;
  delete(ref: string): void;
}
export type ConfigRuntimeOptions = {
  documents: ConfigDocumentStore;
  secrets: ConfigSecretStore;
  newId: () => string;
};
export type ConfigScope = { service: ScopedConfigService; dispose(): void };
export interface ConfigRuntime { createScope(scope: string): ConfigScope }
