import { BaseError } from "../errors/index.js";

export type ConfigErrorReason = "invalid_definition" | "definition_conflict" | "invalid_values"
  | "invalid_secrets" | "missing_secret" | "invalid_document" | "unsupported_version"
  | "missing_migration" | "migration_failed" | "storage_failed" | "disposed"
  | "profile_not_found" | "no_active_profile" | "active_profile" | "not_initialized";
export type ConfigErrorContext = {
  scope?: string; key?: string; schemaVersion?: number; storedVersion?: number;
  operation?: string; profileId?: string;
};

/** Only controlled identities belong in public context; raw port errors stay in cause. */
export class ConfigError extends BaseError<string, ConfigErrorContext> {
  constructor(readonly reason: ConfigErrorReason, context: ConfigErrorContext = {}, options?: ErrorOptions) {
    super(`CONFIG.${reason.toUpperCase()}`, reason === "storage_failed" ? "storage" : "configuration", context, options);
    this.name = "ConfigError";
  }
}
