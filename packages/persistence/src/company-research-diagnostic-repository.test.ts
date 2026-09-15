import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { getCompanyResearchTemplate, type CompanyResearchModelDiagnostic } from "@deepfield/contracts";
import { createRepositories, migrate, openDatabase } from "./index.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "deepfield-research-diagnostic-"));
  const db = openDatabase(join(directory, "deepfield.sqlite"));
  migrate(db);
  cleanups.push(() => { try { db.close(); } catch { /* closed */ } rmSync(directory, { recursive: true, force: true }); });
  const repos = createRepositories(db);
  const item = repos.capabilityItems.create({ industry: "机器人" });
  const company = repos.companies.upsert({ name: "宇树科技" });
  repos.itemCompanies.add(item.id, company.id);
  const input = { direction: "product_and_technology" as const, asOfDate: "2026-09-15" };
  const context = { ...input, currentDate: "2026-09-15", companyName: "宇树科技", topicName: "机器人" };
  const run = repos.companyResearchRuns.createResearching(item.id, company.id, input, context, getCompanyResearchTemplate(input.direction));
  return { db, repos, run };
}

describe("company research model diagnostic repository", () => {
  it("retains a safe diagnostic after the failed raw run is deleted and queries all correlation ids", () => {
    const f = fixture();
    const diagnostic: CompanyResearchModelDiagnostic = {
      requestId: "request-1", runId: f.run.id, traceId: "trace-1", stage: "raw", type: "model_diagnostic",
      phase: "synthesizing", agentTurns: 12, searchCalls: 8, fetchCalls: 7,
      inputChars: 12000, outputChars: 0, stopReason: "error", errorCategory: "invalid_final_empty",
      startedAt: "2026-09-15T08:00:00.000Z", finishedAt: "2026-09-15T08:00:10.000Z", durationMs: 10000,
    };
    f.repos.companyResearchDiagnostics.record(diagnostic);
    f.repos.companyResearchRuns.deleteResearching(f.run.id);
    expect(f.repos.companyResearchDiagnostics.getByRequestId("request-1")).toEqual(diagnostic);
    expect(f.repos.companyResearchDiagnostics.getByTraceId("trace-1")).toEqual(diagnostic);
    expect(f.repos.companyResearchDiagnostics.listByRunId(f.run.id)).toEqual([diagnostic]);
  });

  it("rejects runtime payloads with extra sensitive fields", () => {
    const f = fixture();
    expect(() => f.repos.companyResearchDiagnostics.record({
      requestId: "request-1", runId: f.run.id, traceId: "trace-1", stage: "raw", type: "model_diagnostic",
      phase: "deciding", agentTurns: 1, searchCalls: 0, fetchCalls: 0, inputChars: 1, outputChars: 0,
      stopReason: "unknown", startedAt: "2026-09-15T08:00:00.000Z", finishedAt: "2026-09-15T08:00:00.001Z", durationMs: 1,
      apiKey: "secret",
    } as never)).toThrow();
  });
});
