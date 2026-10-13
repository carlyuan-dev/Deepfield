export { createConfigRuntime } from "./manager.js";
export { createLegacyProfileManager } from "./legacy-profiles.js";
export type { LegacyProfileManagerOptions, LegacyProfilesView } from "./legacy-profiles.js";
export { ConfigError } from "./config-error.js";
export type { ConfigErrorReason, ConfigErrorContext } from "./config-error.js";
export type { ConfigAddress, ConfigDocumentStore, ConfigSecretStore, ConfigRuntimeOptions, ConfigScope, ConfigRuntime } from "./ports.js";
