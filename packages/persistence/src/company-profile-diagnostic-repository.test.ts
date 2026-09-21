import { describe, expect, it } from "vitest";
import { openDatabase, migrate, createRepositories } from "./index.js";
import type { CompanyProfileDiagnostic } from "./legacy-company-contracts/index.js";
describe("profile diagnostics persistence", () => {
  it("correlates a bounded reason to company/request and rejects untrusted payload fields", () => {
    const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
    try {
      const company = repos.companies.upsert({ name: "诊断目标" });
      const diagnostic: CompanyProfileDiagnostic = { kind: "company-profile.event", type: "diagnostic", requestId: "trace-1", companyId: company.id, phase: "schema", code: "schema_invalid", schemaIssues: [{ path: "/fieldEvidence/legalName/0", expected: "object", actual: "string" }], searchSourceCount: 2, openedSourceCount: 1, searchToolCalls: 2, readToolCalls: 1, outputChars: 420 };
      repos.companyProfileDiagnostics.record(diagnostic);
      expect(repos.companyProfileDiagnostics.getByRequestId("trace-1")).toEqual(diagnostic);
      expect(repos.companyProfileDiagnostics.listByCompanyId(company.id)).toEqual([diagnostic]);
      expect(() => repos.companyProfileDiagnostics.record({ ...diagnostic, requestId: "other", message: "sk-secret" } as CompanyProfileDiagnostic)).toThrow("invalid profile diagnostic");
      repos.companies.deleteIfUnreferenced(company.id);
      expect(repos.companyProfileDiagnostics.listByCompanyId(company.id)).toEqual([]);
    } finally { db.close(); }
  });
});
