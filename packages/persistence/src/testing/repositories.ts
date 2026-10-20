/** Test-only composition of independently owned host and company data layers. */
import { createRepositories as createHost } from "../repositories.js";
import { databaseView, type DatabaseInput } from "../database.js";
import { createCompanyResearchRepositories } from "../../../../capabilities/company-research/persistence/index.js";
export * from "../index.js";
export function createRepositories(connection: DatabaseInput) {
  const host = createHost(connection);
  const company = createCompanyResearchRepositories(databaseView(connection), { version: 1, deleteByTraceIds: ids => host.toolExecutions.deleteByTraceIds(ids) });
  return { ...host, ...company, toolExecutions: host.toolExecutions };
}
export type Repositories = ReturnType<typeof createRepositories>;
