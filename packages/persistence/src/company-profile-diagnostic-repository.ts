import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { CompanyProfileDiagnosticSchema, type CompanyProfileDiagnostic } from "@deepfield/contracts";
import type { CompanyProfileDiagnosticRepository } from "./types.js";
function valid(value: unknown): CompanyProfileDiagnostic {
  if (!Value.Check(CompanyProfileDiagnosticSchema, value)) throw new Error("invalid profile diagnostic");
  return structuredClone(value);
}
export function createCompanyProfileDiagnosticRepository(db: DatabaseSync): CompanyProfileDiagnosticRepository {
  const decode = (row: { diagnostic_json: string }) => valid(JSON.parse(row.diagnostic_json));
  return {
    record(value) {
      const diagnostic = valid(value);
      db.prepare("INSERT INTO company_profile_diagnostics(request_id, company_id, diagnostic_json, created_at) VALUES (?, ?, ?, ?)")
        .run(diagnostic.requestId, diagnostic.companyId, JSON.stringify(diagnostic), new Date().toISOString());
    },
    getByRequestId(requestId) {
      const row = db.prepare("SELECT diagnostic_json FROM company_profile_diagnostics WHERE request_id = ?").get(requestId) as { diagnostic_json: string } | undefined;
      return row === undefined ? undefined : decode(row);
    },
    listByCompanyId(companyId) {
      const rows = db.prepare("SELECT diagnostic_json FROM company_profile_diagnostics WHERE company_id = ? ORDER BY created_at, request_id").all(companyId) as Array<{ diagnostic_json: string }>;
      return rows.map(decode);
    },
  };
}
