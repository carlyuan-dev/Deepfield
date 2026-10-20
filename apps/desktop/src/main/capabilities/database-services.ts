import { assertDatabase } from "@deepfield/base/database";
import { assertToolsAuditService } from "@deepfield/base/tools";
import type { CapabilityHostServices } from "@deepfield/capability-sdk";
import type { Database } from "@deepfield/base/database";

export function createCapabilityDatabaseServices(base: CapabilityHostServices, database: Database): CapabilityHostServices {
  return Object.freeze({ version: 1 as const,
    has: (name: string) => name === "database.v1" || base.has(name),
    get<T>(name: string): T { return name === "database.v1" ? database as T : base.get<T>(name); },
  });
}
export function assertStorageServices(services: CapabilityHostServices, requirements: readonly string[]): void {
  if (requirements.includes("database.v1")) assertDatabase(services.get("database.v1"));
  if (requirements.includes("tools.audit.v1")) assertToolsAuditService(services.get("tools.audit.v1"));
}

/** Only bounded, recognized migration diagnostics may cross the status boundary. */
export function migrationDiagnostic(error: unknown): { namespace: string; version: number; stage: string; code?: string } | undefined {
  if (!(error instanceof Error) || !("diagnostic" in error)) return;
  const d = error.diagnostic;
  if (!d || typeof d !== "object") return;
  const value = d as Record<string, unknown>;
  if (typeof value.namespace !== "string" || !/^capability:[a-z0-9][a-z0-9-]*$/.test(value.namespace) || value.namespace.length > 128 ||
    typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0 ||
    typeof value.stage !== "string" || !["declaration", "transaction", "baseline", "ledger", "apply", "record"].includes(value.stage)) return;
  return { namespace: value.namespace, version: value.version, stage: value.stage,
    ...(typeof value.code === "string" && /^(?:ERR_SQLITE_[A-Z_]+|SQLITE_[A-Z_]+)$/.test(value.code) ? { code: value.code } : {}) };
}
