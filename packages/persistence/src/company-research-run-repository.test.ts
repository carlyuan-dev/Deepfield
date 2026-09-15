import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCompanyResearchTemplate, type CompanyResearchContext,
  type StartCompanyResearchInput, type StructuredResearchContent,
} from "@deepfield/contracts";
import { createRepositories, migrate, openDatabase } from "./index.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const input: StartCompanyResearchInput = {
  direction: "product_and_technology", focusScope: "海外业务", asOfDate: "2026-09-11",
};
const context: CompanyResearchContext = {
  ...input, companyName: "ACME", topicName: "Robotics", currentDate: "2026-09-11",
  aliases: ["ACME Robotics"], topicScope: "整机", companyNote: "首选",
};
const template = getCompanyResearchTemplate(input.direction);
const content: StructuredResearchContent = {
  coreSummary: ["暂无足够信息"],
  sections: template.sections.map(({ sectionId }) => ({
    sectionId, status: "not_found", summary: null, facts: [],
  })),
};
const rawText = "# 原始报告\n[来源](https://example.com/a)";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "deepfield-research-runs-"));
  const path = join(directory, "deepfield.sqlite");
  const db = openDatabase(path);
  migrate(db);
  cleanups.push(() => {
    try { db.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  });
  const repos = createRepositories(db);
  const item = repos.capabilityItems.create({ industry: "Robotics" });
  const company = repos.companies.upsert({ name: "ACME" });
  repos.itemCompanies.add(item.id, company.id);
  const repo = repos.companyResearchRuns;
  const create = () => repo.createResearching(item.id, company.id, input, context, template);
  return { db, path, repos, repo, item, company, create };
}

describe("company research run repository", () => {
  it("stores detached context and template snapshots before raw output, across reopen", () => {
    const f = fixture();
    const supplied = structuredClone(context);
    const run = f.repo.createResearching(f.item.id, f.company.id, input, supplied, template);
    supplied.companyName = "changed";
    expect(run).toMatchObject({
      status: "researching", schemaVersion: "company-research-report-v1",
      researchContext: { companyName: "ACME" }, template, harnessVersion: 1, structuringAttempts: 0,
    });
    expect(run).not.toHaveProperty("rawReportText");
    f.db.close();
    const reopened = openDatabase(f.path);
    cleanups.push(() => reopened.close());
    migrate(reopened);
    const repo = createRepositories(reopened).companyResearchRuns;
    expect(repo.getByIdForTarget(f.item.id, f.company.id, run.id)).toEqual(run);
    expect(repo.getActive()).toMatchObject({ id: run.id, status: "researching" });
    for (const field of ["researchContext", "template", "harnessVersion", "rawReportText", "structuredContent"]) {
      expect(repo.getActive()).not.toHaveProperty(field);
    }
    expect(repo.listRuns(f.item.id, f.company.id)).toEqual([]);
  });

  it("commits raw output before structuring and preserves it through failure and retry", () => {
    const f = fixture();
    const run = f.create();
    const structuring = f.repo.completeRaw(run.id, rawText);
    expect(structuring).toMatchObject({ status: "structuring", rawReportText: rawText, structuringAttempts: 1 });
    expect(structuring.rawCompletedAt).toBeTruthy();
    const connection = openDatabase(f.path);
    cleanups.push(() => connection.close());
    expect(createRepositories(connection).companyResearchRuns.getByIdForTarget(f.item.id, f.company.id, run.id)).toEqual(structuring);
    expect(f.repo.failStructuring(run.id)).toMatchObject({
      status: "structure_failed", rawReportText: rawText, lastFailureCode: "structuring_failed",
    });
    expect(f.repo.getActive()).toBeUndefined();
    const retry = f.repo.retryStructuring(run.id);
    expect(retry).toMatchObject({ status: "structuring", structuringAttempts: 2, rawCompletedAt: structuring.rawCompletedAt });
    expect(retry).not.toHaveProperty("lastFailureCode");
    const completed = f.repo.completeStructured(run.id, content);
    expect(completed).toMatchObject({ status: "completed", structuredContent: content, rawReportText: rawText, structuringAttempts: 2 });
    expect(completed.completedAt).toBeTruthy();
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, run.id)).toEqual(completed);
  });

  it("retries failed runs in place while clearing only artifacts invalid for the new stage", () => {
    const f = fixture();
    const changedInput: StartCompanyResearchInput = {
      direction: "market_and_commercialization", focusScope: "最新量产", asOfDate: "2026-09-16",
    };
    const changedContext: CompanyResearchContext = {
      ...context, ...changedInput, currentDate: "2026-09-16", companyNote: "changed",
    };
    const changedTemplate = getCompanyResearchTemplate(changedInput.direction);
    const run = f.create();
    const failed = f.repo.failResearching(run.id, "tool_failed");
    expect(failed).toMatchObject({ id: run.id, status: "research_failed", lastFailureCode: "tool_failed" });
    const retried = f.repo.retryResearching(
      failed.id, changedInput, changedContext, changedTemplate, "2026-09-16T10:00:00.000Z",
    );
    expect(retried).toMatchObject({
      id: failed.id, status: "researching", focusScope: "最新量产",
      createdAt: "2026-09-16T10:00:00.000Z", structuringAttempts: 0,
    });
    expect(retried).not.toHaveProperty("rawReportText");
    expect(retried).not.toHaveProperty("lastFailureCode");

    const failedAgain = f.repo.failResearching(retried.id, "model_failed");
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, failedAgain.id)?.id).toBe(run.id);
    f.repo.retryResearching(failedAgain.id, input, context, template, "2026-09-16T10:01:00.000Z");
    f.repo.completeRaw(run.id, rawText);
    const structureFailed = f.repo.failStructuring(run.id);
    const restarted = f.repo.retryResearching(
      structureFailed.id, changedInput, changedContext, changedTemplate, "2026-09-16T10:02:00.000Z",
    );
    expect(restarted).toMatchObject({ id: run.id, status: "researching", structuringAttempts: 0 });
    for (const field of ["rawReportText", "rawCompletedAt", "structuredContent", "completedAt", "lastFailureCode"]) {
      expect(restarted).not.toHaveProperty(field);
    }

    f.repo.completeRaw(run.id, rawText);
    f.repo.failStructuring(run.id);
    const structuring = f.repo.retryStructuring(run.id, "2026-09-16T10:03:00.000Z");
    expect(structuring).toMatchObject({
      id: run.id, status: "structuring", rawReportText: rawText,
      structuringAttempts: 2, createdAt: "2026-09-16T10:03:00.000Z",
    });
    expect(structuring).not.toHaveProperty("lastFailureCode");
  });

  it("deletes only active or owned terminal runs and includes raw failures in history", () => {
    const f = fixture();
    const researching = f.create();
    expect(() => f.repo.deleteTerminal(f.item.id, f.company.id, researching.id)).toThrow();
    expect(f.repo.deleteActive(researching.id)).toBe(true);
    const structuring = f.create();
    f.repo.completeRaw(structuring.id, rawText);
    expect(f.repo.deleteActive(structuring.id)).toBe(true);

    const failed = f.create();
    f.repo.failResearching(failed.id, "tool_failed");
    expect(f.repo.listRuns(f.item.id, f.company.id).map((run) => run.id)).toContain(failed.id);
    expect(() => f.repo.deleteActive(failed.id)).toThrow();
    expect(() => f.repo.deleteTerminal("other" as never, f.company.id, failed.id)).toThrow();
    expect(f.repo.deleteTerminal(f.item.id, f.company.id, failed.id)).toBe(true);
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, failed.id)).toBeUndefined();
  });

  it("guards every state transition, including deletion and missing IDs", () => {
    const f = fixture();
    const run = f.create();
    expect(() => f.repo.completeStructured(run.id, content)).toThrow();
    expect(() => f.repo.failStructuring(run.id)).toThrow();
    expect(() => f.repo.retryStructuring(run.id)).toThrow();
    f.repo.completeRaw(run.id, rawText);
    expect(() => f.repo.completeRaw(run.id, "replacement")).toThrow();
    expect(() => f.repo.deleteResearching(run.id)).toThrow();
    f.repo.failStructuring(run.id);
    expect(() => f.repo.failStructuring(run.id)).toThrow();
    expect(() => f.repo.completeStructured(run.id, content)).toThrow();
    f.repo.retryStructuring(run.id);
    expect(() => f.repo.retryStructuring(run.id)).toThrow();
    f.repo.completeStructured(run.id, content);
    expect(() => f.repo.completeStructured(run.id, content)).toThrow();
    expect(() => f.repo.deleteResearching(run.id)).toThrow();
    const deleted = f.create();
    expect(f.repo.deleteResearching(deleted.id)).toBe(true);
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, deleted.id)).toBeUndefined();
    expect(() => f.repo.deleteResearching(deleted.id)).toThrow();
    expect(() => f.repo.completeRaw(deleted.id, rawText)).toThrow();
  });

  it("enforces one global active run across stages, targets, connections, and retry", () => {
    const f = fixture();
    const other = f.repos.capabilityItems.create({ industry: "Other" });
    f.repos.itemCompanies.add(other.id, f.company.id);
    const connection = openDatabase(f.path);
    cleanups.push(() => connection.close());
    const repo = createRepositories(connection).companyResearchRuns;
    const createOther = () => repo.createResearching(other.id, f.company.id, input, context, template);
    const run = f.create();
    expect(createOther).toThrow();
    f.repo.completeRaw(run.id, rawText);
    expect(createOther).toThrow();
    f.repo.failStructuring(run.id);
    const otherRun = createOther();
    expect(() => f.repo.retryStructuring(run.id)).toThrow();
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, run.id)?.status).toBe("structure_failed");
    repo.deleteResearching(otherRun.id);
    expect(f.repo.retryStructuring(run.id).structuringAttempts).toBe(2);
  });

  it("recovers both interrupted stages idempotently and preserves terminal rows", () => {
    const f = fixture();
    const done = f.create();
    f.repo.completeRaw(done.id, rawText);
    const completed = f.repo.completeStructured(done.id, content);
    const run = f.create();
    const structuring = f.repo.completeRaw(run.id, rawText);
    expect(f.repo.recoverAbandoned()).toEqual({ failedResearching: 0, failedStructuring: 1 });
    const failed = f.repo.getByIdForTarget(f.item.id, f.company.id, run.id);
    expect(failed).toMatchObject({ status: "structure_failed", rawReportText: rawText, rawCompletedAt: structuring.rawCompletedAt, structuringAttempts: 1 });
    const abandoned = f.create();
    expect(f.repo.recoverAbandoned()).toEqual({ failedResearching: 1, failedStructuring: 0 });
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, abandoned.id)).toMatchObject({
      status: "research_failed", lastFailureCode: "incomplete_response",
    });
    expect(f.repo.recoverAbandoned()).toEqual({ failedResearching: 0, failedStructuring: 0 });
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, run.id)).toEqual(failed);
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, done.id)).toEqual(completed);
  });

  it("lists body-free terminal history newest-first with deterministic ties", () => {
    const f = fixture();
    const completed = f.create();
    f.repo.completeRaw(completed.id, rawText);
    f.repo.completeStructured(completed.id, content);
    f.db.prepare("UPDATE company_research_runs SET completed_at = '2026-09-01' WHERE id = ?").run(completed.id);
    const rawFailed = f.create();
    f.repo.failResearching(rawFailed.id, "tool_failed");
    f.db.prepare("UPDATE company_research_runs SET created_at = '2026-09-03' WHERE id = ?").run(rawFailed.id);
    const failed = f.create();
    f.repo.completeRaw(failed.id, rawText);
    f.repo.failStructuring(failed.id);
    const active = f.create();
    expect(f.repo.listRuns(f.item.id, f.company.id).map((run) => run.id)).toEqual([failed.id, rawFailed.id, completed.id]);
    f.repo.completeRaw(active.id, rawText);
    f.repo.failStructuring(active.id);
    f.db.prepare("UPDATE company_research_runs SET raw_completed_at = '2026-09-02' WHERE status = 'structure_failed'").run();
    const runs = f.repo.listRuns(f.item.id, f.company.id);
    expect(runs.map((run) => run.id)).toEqual([rawFailed.id, ...[failed.id, active.id].sort().reverse(), completed.id]);
    for (const run of runs) {
      for (const field of ["reportText", "rawReportText", "structuredContent", "researchContext", "template", "harnessVersion"]) {
        expect(run).not.toHaveProperty(field);
      }
    }
  });

  it("scopes detail and history to membership and cascades only the removed target", () => {
    const f = fixture();
    const other = f.repos.capabilityItems.create({ industry: "Other" });
    f.repos.itemCompanies.add(other.id, f.company.id);
    const otherCompany = f.repos.companies.upsert({ name: "Other Company" });
    expect(() => f.repo.createResearching(f.item.id, otherCompany.id, input, context, template)).toThrow();
    const run = f.create();
    f.repo.completeRaw(run.id, rawText);
    f.repo.completeStructured(run.id, content);
    expect(f.repo.getByIdForTarget(other.id, f.company.id, run.id)).toBeUndefined();
    expect(f.repo.getByIdForTarget(f.item.id, otherCompany.id, run.id)).toBeUndefined();
    expect(f.repo.listRuns(other.id, f.company.id)).toEqual([]);
    const second = f.repo.createResearching(other.id, f.company.id, input, context, template);
    f.repos.itemCompanies.remove(f.item.id, f.company.id);
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, run.id)).toBeUndefined();
    expect(f.repo.getByIdForTarget(other.id, f.company.id, second.id)).toEqual(second);
    f.repos.capabilityItems.delete(other.id);
    expect(f.repo.getActive()).toBeUndefined();
  });

  it("rejects invalid inputs and output before mutating durable state", () => {
    const f = fixture();
    expect(() => f.repo.createResearching(f.item.id, f.company.id, { ...input, direction: "invalid" } as never, context, template)).toThrow();
    expect(() => f.repo.createResearching(f.item.id, f.company.id, input, { ...context, companyName: "" }, template)).toThrow();
    expect(() => f.repo.createResearching(f.item.id, f.company.id, input, { ...context, asOfDate: "2025-01-01" }, template)).toThrow();
    expect(() => f.repo.createResearching(f.item.id, f.company.id, input, context, getCompanyResearchTemplate("operations_and_performance"))).toThrow();
    expect(f.repo.getActive()).toBeUndefined();
    const run = f.create();
    for (const text of ["", " \n\t", "x".repeat(1_000_001)]) expect(() => f.repo.completeRaw(run.id, text)).toThrow();
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, run.id)).toEqual(run);
    const structuring = f.repo.completeRaw(run.id, rawText);
    expect(() => f.repo.completeStructured(run.id, { ...content, sections: [] })).toThrow();
    expect(() => f.repo.completeStructured(run.id, { ...content, secret: "private" } as never)).toThrow();
    expect(f.repo.getByIdForTarget(f.item.id, f.company.id, run.id)).toEqual(structuring);
  });

  it.each([
    ["research_context_json", '{"private":"sensitive malformed'],
    ["research_context_json", JSON.stringify({ ...context, companyName: 123 })],
    ["research_context_json", JSON.stringify({ ...context, direction: "operations_and_performance" })],
    ["template_snapshot_json", "null"],
    ["template_snapshot_json", JSON.stringify({ ...template, sections: [] })],
    ["template_id", "operations_and_performance"],
    ["template_version", 2],
    ["harness_version", 2],
    ["structured_content_json", '{"private":"sensitive malformed'],
    ["structured_content_json", JSON.stringify({ coreSummary: [], sections: [] })],
    ["raw_report_text", null],
    ["raw_report_text", " \n\t"],
    ["raw_completed_at", null],
    ["completed_at", null],
    ["structuring_attempts", 0],
    ["last_failure_code", "structuring_failed"],
    ["legacy_report_text", "unexpected legacy body"],
  ])("rejects corrupt completed %s on detail and summary reads", (column, value) => {
    const f = fixture();
    const run = f.create();
    f.repo.completeRaw(run.id, rawText);
    f.repo.completeStructured(run.id, content);
    f.db.exec("PRAGMA ignore_check_constraints = ON");
    f.db.prepare(`UPDATE company_research_runs SET ${column} = ? WHERE id = ?`).run(value, run.id);
    expect(() => f.repo.getByIdForTarget(f.item.id, f.company.id, run.id)).toThrow("invalid persisted research run");
    expect(() => f.repo.listRuns(f.item.id, f.company.id)).toThrow("invalid persisted research run");
  });

  it.each([
    ["researching", "raw_report_text", rawText],
    ["researching", "structuring_attempts", 1],
    ["structuring", "raw_completed_at", null],
    ["structuring", "completed_at", "2026-09-11"],
    ["structure_failed", "last_failure_code", null],
    ["structure_failed", "structured_content_json", JSON.stringify(content)],
  ])("rejects %s rows with inconsistent %s", (status, column, value) => {
    const f = fixture();
    const run = f.create();
    if (status !== "researching") f.repo.completeRaw(run.id, rawText);
    if (status === "structure_failed") f.repo.failStructuring(run.id);
    f.db.exec("PRAGMA ignore_check_constraints = ON");
    f.db.prepare(`UPDATE company_research_runs SET ${column} = ? WHERE id = ?`).run(value, run.id);
    expect(() => f.repo.getByIdForTarget(f.item.id, f.company.id, run.id)).toThrow("invalid persisted research run");
    if (status !== "structure_failed") expect(() => f.repo.getActive()).toThrow("invalid persisted research run");
  });

  it.each([
    ["failure code", "last_failure_code = NULL"],
    ["raw report", "raw_report_text = NULL"],
    ["raw completion time", "raw_completed_at = NULL"],
    ["positive structuring attempts", "structuring_attempts = 0"],
  ])("rejects direct SQL structure failures without a %s", (_field, assignment) => {
    const f = fixture();
    const run = f.create();
    f.repo.completeRaw(run.id, rawText);
    f.repo.failStructuring(run.id);

    expect(() => f.db.prepare(`UPDATE company_research_runs SET ${assignment} WHERE id = ?`).run(run.id)).toThrow();
  });
});
