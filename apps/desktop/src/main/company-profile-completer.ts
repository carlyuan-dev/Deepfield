import { randomUUID } from "node:crypto";
import { AppError, CompanyProfileFieldsSchema, CompanyProfileResultSchema, type CompanyProfileDiagnostic, type CompanyProfileFields, type CompanyProfileWorkerEvent } from "@deepfield/contracts";
import type { CompanyProfileCompleter, CompanyProfileWorkerPort, RuntimeProfileResolver } from "@deepfield/application";
import { Value } from "typebox/value";

export class CompanyProfileExecutionError extends AppError {
  constructor(readonly requestId: string, readonly companyId: string, readonly failureCode: Extract<CompanyProfileWorkerEvent, { type: "failed" }>["code"], invalidFormat = false) {
    super(invalidFormat ? "EXTERNAL.INVALID_RESPONSE" : "EXTERNAL.UNAVAILABLE", invalidFormat ? { service: "llm" } : failureCode === "search_unavailable" ? { service: "search" } : undefined);
  }
}
export function createCompanyProfileCompleter(profiles: RuntimeProfileResolver, worker: CompanyProfileWorkerPort, recordDiagnostic?: (value: CompanyProfileDiagnostic) => void): CompanyProfileCompleter {
  return { async prepare(company, researchTopics) {
    const llm = await profiles.resolveActiveLlm();
    const search = await profiles.resolveActiveSearch();
    const existingFields = Object.fromEntries(Object.keys(CompanyProfileFieldsSchema.properties)
      .filter((key) => company[key as keyof typeof company] !== undefined)
      .map((key) => [key, company[key as keyof typeof company]])) as CompanyProfileFields;
    return async () => {
      let invalidFormat = false;
      for await (const event of worker.sendProfile({ kind: "company-profile.enrich", requestId: randomUUID(), companyId: company.id, name: company.name, researchTopics, existingFields, ...(company.profileIdentityHint ? { identityHint: company.profileIdentityHint } : {}), llm, search })) {
        if (event.type === "diagnostic") {
          invalidFormat = event.code === "json_parse" || event.code === "schema_invalid";
          try { recordDiagnostic?.(event); } catch { /* Same failure-isolated persistence policy as research diagnostics. */ }
          continue;
        }
        if (event.type === "completed" && Value.Check(CompanyProfileResultSchema, event.result)) return event.result;
        if (event.type === "failed") throw new CompanyProfileExecutionError(event.requestId, event.companyId, event.code, invalidFormat);
      }
      throw new AppError("INTERNAL.UNKNOWN");
    };
  } };
}
