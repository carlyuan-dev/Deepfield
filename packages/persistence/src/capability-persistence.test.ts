import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { getCompanyResearchTemplate } from "../../../capabilities/company-research/contracts/index.js";
import { profileResult } from "../../application/src/testing/company-profile-test-fixtures.js";
import { createRepositories, migrate, openDatabase } from "./index.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("Capability A persistence", () => {
  it("reopens items, reuses companies across items, and removes only membership", () => {
    const dir = mkdtempSync(join(tmpdir(), "deepfield-capability-"));
    const path = join(dir, "deepfield.sqlite");
    const db = openDatabase(path);
    migrate(db);
    cleanups.push(() => {
      try {
        db.close();
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true });
    });

    const repos = createRepositories(db);
    const first = repos.capabilityItems.create({
      industry: "人形机器人",
      researchScope: "整机与核心零部件",
      notes: "首轮研究",
    });
    const second = repos.capabilityItems.create({
      industry: "工业软件",
    });

    const company = repos.companies.upsert({
      name: "  ＡＣＭＥ\t  Corp  ",
    });
    const reused = repos.companies.upsert({ name: "acme corp" });
    expect(reused.id).toBe(company.id);
    expect(company.normalizedName).toBe("acme corp");
    expect(company.name).toBe("ＡＣＭＥ\t  Corp");

    repos.itemCompanies.add(first.id, company.id, "首选供应商");
    repos.itemCompanies.add(first.id, company.id, "重复关联应被忽略");
    repos.itemCompanies.add(second.id, company.id, "跨条目复用");
    expect(repos.itemCompanies.listByItem(first.id)).toHaveLength(1);
    expect(repos.itemCompanies.listByItem(second.id)).toHaveLength(1);

    repos.itemCompanies.remove(first.id, company.id);
    expect(repos.itemCompanies.listByItem(first.id)).toEqual([]);
    expect(repos.companies.getById(company.id)?.name).toBe("ＡＣＭＥ\t  Corp");
    expect(repos.itemCompanies.listByItem(second.id)).toHaveLength(1);

    db.close();
    const reopened = openDatabase(path);
    cleanups.push(() => {
      try {
        reopened.close();
      } catch {
        // already closed
      }
    });
    migrate(reopened);
    const reopenedRepos = createRepositories(reopened);

    expect(reopenedRepos.capabilityItems.getById(first.id)?.industry).toBe("人形机器人");
    expect(reopenedRepos.capabilityItems.list()).toHaveLength(2);
    expect(reopenedRepos.companies.getById(company.id)?.normalizedName).toBe("acme corp");
    expect(reopenedRepos.itemCompanies.listByItem(first.id)).toEqual([]);
    expect(reopenedRepos.itemCompanies.listByItem(second.id)).toHaveLength(1);

    const tableNames = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as unknown as Array<{ name: string }>;
    const names = tableNames.map((table) => table.name);
    expect(names).not.toContain("projects");
    expect(names).not.toContain("project_activity_events");
    expect(names).toEqual(
      expect.arrayContaining([
        "capability_items",
        "companies",
        "capability_item_companies",
        "conversations",
        "messages",
        "tool_executions",
      ]),
    );
  });

  it("persists a shared company profile without overwriting it during reuse", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    cleanups.push(() => db.close());
    const repos = createRepositories(db);
    const first = repos.capabilityItems.create({ industry: "机器人" });
    const second = repos.capabilityItems.create({ industry: "工业软件" });

    const company = repos.companies.upsert({ name: "ACME" });
    expect(company.profileStatus).toBe("pending");
    const profiled = repos.companies.update(company.id, {
      name: "ACME Corporation",
      legalName: "ACME Corporation Ltd.",
      aliases: [],
      headquarters: "Boston, Massachusetts, US",
      foundedAt: "1998",
      officialWebsite: null,
      stockListings: [],
      businessTags: ["工业机器人", "机器视觉"],
    });
    expect(profiled).toMatchObject({
      id: company.id,
      normalizedName: "acme corporation",
      aliases: [],
      officialWebsite: null,
      stockListings: [],
      businessTags: ["工业机器人", "机器视觉"],
      profileStatus: "ready",
    });

    repos.itemCompanies.add(first.id, company.id, "首选供应商");
    repos.itemCompanies.add(second.id, company.id, "竞品");
    const reused = repos.companies.upsert({ name: "acme corporation" });
    expect(reused).toEqual(profiled);
    expect(repos.companies.getById(company.id)).toEqual(profiled);
    expect(repos.itemCompanies.listByItem(first.id)[0]?.note).toBe("首选供应商");
    expect(repos.itemCompanies.listByItem(second.id)[0]?.note).toBe("竞品");
  });

  it("persists profile queue state and recovers interrupted work", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    cleanups.push(() => db.close());
    const repos = createRepositories(db);
    const first = repos.companies.upsert({ name: "First" });
    const second = repos.companies.upsert({ name: "Second" });

    expect(repos.companies.getNextPendingProfile()?.id).toBe(first.id);
    expect(repos.companies.setProfileStatus(first.id, "enriching")?.profileStatus).toBe("enriching");
    expect(repos.companies.getNextPendingProfile()?.id).toBe(second.id);
    expect(repos.companies.resetEnrichingProfiles()).toBe(1);
    expect(repos.companies.getById(first.id)?.profileStatus).toBe("pending");
    expect(repos.companies.setProfileStatus(first.id, "failed")?.profileStatus).toBe("failed");
  });

  it("atomically saves an identity hint on a failed profile without changing company facts", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    cleanups.push(() => db.close());
    const repos = createRepositories(db);
    const company = repos.companies.upsert({ name: "三星" });
    repos.companies.update(company.id, { name: company.name, headquarters: "手工地点" });
    db.prepare("UPDATE companies SET profile_status = 'enriching' WHERE id = ?").run(company.id);
    repos.companies.completeProfile(company.id, {}, { ...profileResult({}),
      identity: { disposition: "ambiguous", reason: "检索到多个同名主体", sources: [{ url: "https://example.com", kind: "search_snippet" }] },
      fields: {}, fieldEvidence: {},
    });

    const confirmed = repos.companies.confirmProfileIdentity(company.id, {
      name: "三星电子株式会社",
      officialWebsite: "https://www.samsung.com/",
    });

    expect(confirmed).toMatchObject({
      id: company.id,
      name: "三星",
      headquarters: "手工地点",
      profileStatus: "pending",
      profileIdentityHint: { name: "三星电子株式会社", officialWebsite: "https://www.samsung.com/" },
    });
    expect(confirmed?.legalName).toBeUndefined();
    expect(confirmed?.officialWebsite).toBeUndefined();
    expect(confirmed?.profileIssue).toBeUndefined();
    expect(confirmed?.profileProvenance).toBeUndefined();
  });

  it("rejects confirmation for missing, ready, or running companies and preserves a saved hint after failure", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    cleanups.push(() => db.close());
    const repos = createRepositories(db);
    const company = repos.companies.upsert({ name: "摩托罗拉" });
    repos.companies.setProfileStatus(company.id, "failed", { code: "EXTERNAL.TIMEOUT", category: "external" });
    expect(repos.companies.confirmProfileIdentity(company.id, { name: "Motorola Mobility LLC" })?.profileStatus).toBe("pending");
    repos.companies.setProfileStatus(company.id, "enriching");
    expect(repos.companies.confirmProfileIdentity(company.id, { name: "运行中不可覆盖" })).toBeUndefined();
    repos.companies.setProfileStatus(company.id, "failed", { code: "EXTERNAL.TIMEOUT", category: "external" });
    expect(repos.companies.getById(company.id)?.profileIdentityHint).toEqual({ name: "Motorola Mobility LLC" });
    expect(repos.companies.confirmProfileIdentity(company.id, { name: "另一主体" })?.profileStatus).toBe("pending");
    repos.companies.update(company.id, { name: company.name });
    expect(repos.companies.confirmProfileIdentity(company.id, { name: "不可覆盖" })).toBeUndefined();
    expect(repos.companies.confirmProfileIdentity("missing" as never, { name: "不存在" })).toBeUndefined();
  });

  it("rejects a profile rename that conflicts with another normalized name", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    cleanups.push(() => db.close());
    const repos = createRepositories(db);
    const first = repos.companies.upsert({ name: "Alpha" });
    repos.companies.upsert({ name: "Beta" });

    expect(() =>
      repos.companies.update(first.id, {
        name: " ＢＥＴＡ ",
      }),
    ).toThrow(/already exists/i);
    expect(repos.companies.getById(first.id)?.name).toBe("Alpha");
  });

  it("migrates legacy country data into headquarters and marks existing companies ready", () => {
    const db = openDatabase(":memory:");
    cleanups.push(() => db.close());
    db.exec(`
      CREATE TABLE conversations(id TEXT PRIMARY KEY);
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES
        (1, ''), (2, ''), (3, ''), (4, ''), (5, '');
      CREATE TABLE companies(
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        country_or_region TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO companies VALUES('legacy', 'Legacy Co', 'legacy co', 'Singapore', '', '');
      CREATE TABLE capability_item_companies(item_id TEXT, company_id TEXT, PRIMARY KEY(item_id, company_id));
      CREATE TABLE company_research_runs(
        id TEXT PRIMARY KEY, item_id TEXT, company_id TEXT, status TEXT,
        time_scope TEXT, custom_requirements TEXT, report_text TEXT,
        created_at TEXT, completed_at TEXT
      );
    `);

    const beforeCompanyIds = db.prepare("SELECT id FROM companies ORDER BY id").all();
    migrate(db);
    expect(db.prepare("SELECT id FROM companies ORDER BY id").all()).toEqual(beforeCompanyIds);
    const company = createRepositories(db).companies.getById("legacy" as never);
    expect(company).toMatchObject({
      headquarters: "Singapore",
      profileStatus: "ready",
    });
    expect(company).not.toHaveProperty("countryOrRegion");
    const cleared = createRepositories(db).companies.update("legacy" as never, {
      name: "Legacy Co",
    });
    expect(cleared?.headquarters).toBeUndefined();
  });

  it("migrates completed legacy reports without a body limit and discards abandoned running rows", () => {
    const db = openDatabase(":memory:");
    cleanups.push(() => db.close());
    db.exec(`
      CREATE TABLE conversations(id TEXT PRIMARY KEY);
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (1,''),(2,''),(3,''),(4,''),(5,''),(6,''),(7,'');
      CREATE TABLE companies(id TEXT PRIMARY KEY);
      CREATE TABLE capability_item_companies(item_id TEXT, company_id TEXT, PRIMARY KEY(item_id, company_id));
      INSERT INTO capability_item_companies VALUES ('item', 'company');
      CREATE TABLE company_research_runs(
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL, company_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed')),
        time_scope TEXT NOT NULL, custom_requirements TEXT, report_text TEXT,
        created_at TEXT NOT NULL, completed_at TEXT,
        FOREIGN KEY(item_id, company_id) REFERENCES capability_item_companies(item_id, company_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_company_research_one_running ON company_research_runs(status) WHERE status = 'running';
      CREATE INDEX idx_company_research_completed_history ON company_research_runs(item_id, company_id, completed_at DESC, id DESC) WHERE status = 'completed';
      INSERT INTO company_research_runs VALUES
        ('old', 'item', 'company', 'completed', '近一年', '原要求', '旧报告', '2026-01-01', '2026-01-02'),
        ('abandoned', 'item', 'company', 'running', '近一年', NULL, NULL, '2026-01-03', NULL);
    `);
    const hugeReport = "旧".repeat(1_000_001);
    db.prepare("INSERT INTO company_research_runs VALUES ('large', 'item', 'company', 'completed', '不限时间', NULL, ?, '2026-02-01', '2026-02-02')").run(hugeReport);
    const beforeReportIds = db.prepare("SELECT id FROM company_research_runs WHERE status = 'completed' ORDER BY id").all();
    migrate(db);
    migrate(db);
    expect(db.prepare("SELECT id FROM company_research_runs ORDER BY id").all()).toEqual(beforeReportIds);
    const repo = createRepositories(db).companyResearchRuns;
    expect(repo.getByIdForTarget("item" as never, "company" as never, "old" as never)).toMatchObject({
      schemaVersion: "legacy-freeform-v1", status: "completed", searchStatus: "unknown", reportText: "旧报告",
      timeScope: "近一年", customRequirements: "原要求", createdAt: "2026-01-01", completedAt: "2026-01-02",
    });
    expect(repo.getByIdForTarget("item" as never, "company" as never, "large" as never)).toHaveProperty("reportText", hugeReport);
    expect(repo.getByIdForTarget("item" as never, "company" as never, "abandoned" as never)).toBeUndefined();
    const summaries = repo.listRuns("item" as never, "company" as never);
    expect(summaries.map((run) => run.id)).toEqual(["large", "old"]);
    for (const summary of summaries) expect(summary).not.toHaveProperty("reportText");
    expect(repo.recoverAbandoned()).toEqual({ failedResearching: 0, failedStructuring: 0 });
    expect(repo.listRuns("item" as never, "company" as never)).toEqual(summaries);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toMatchObject({ version: 29 });
    expect(db.prepare("PRAGMA table_info(company_research_model_diagnostics)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "attempt" }),
      expect.objectContaining({ name: "validation_issues_json" }),
      expect.objectContaining({ name: "failed_candidate" }),
    ]));
    db.prepare("DELETE FROM capability_item_companies WHERE item_id = 'item' AND company_id = 'company'").run();
    expect(repo.listRuns("item" as never, "company" as never)).toEqual([]);
  });

  it("upgrades v12 history to retain bounded raw failures without storing artifacts", () => {
    const db = openDatabase(":memory:");
    cleanups.push(() => db.close());
    // Seed v13 as applied so migrate constructs the exact v12 database first.
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (13, '');
    `);
    migrate(db);
    // This setup is the v12 durable shape before the v13 table rebuild.
    db.prepare("DELETE FROM schema_migrations WHERE version = 13").run();
    const repos = createRepositories(db);
    const item = repos.capabilityItems.create({ industry: "Robotics" });
    const company = repos.companies.upsert({ name: "ACME" });
    repos.itemCompanies.add(item.id, company.id);
    const input = { direction: "product_and_technology" as const, asOfDate: "2026-09-16" };
    const context = { ...input, currentDate: "2026-09-16", companyName: "ACME", topicName: "Robotics" };
    const template = getCompanyResearchTemplate(input.direction);
    const completed = repos.companyResearchRuns.createResearching(item.id, company.id, input, context, template);
    repos.companyResearchRuns.completeRaw(completed.id, "raw report");
    repos.companyResearchRuns.completeStructured(completed.id, {
      coreSummary: ["summary"], sections: template.sections.map(({ sectionId }) => ({ sectionId, status: "not_found" as const, summary: null, facts: [] })),
    });
    const structured = repos.companyResearchRuns.createResearching(item.id, company.id, input, context, template);
    repos.companyResearchRuns.completeRaw(structured.id, "raw report");
    repos.companyResearchRuns.failStructuring(structured.id);

    migrate(db);
    const insertFailed = db.prepare(`
      INSERT INTO company_research_runs(
        id, item_id, company_id, schema_version, status, research_direction, focus_scope, as_of_date,
        research_context_json, template_id, template_version, template_snapshot_json, harness_version,
        structuring_attempts, last_failure_code, created_at
      ) VALUES (?, ?, ?, 'company-research-report-v1', 'research_failed', ?, NULL, ?, ?, ?, ?, ?, 1, 0, ?, ?)
    `);
    insertFailed.run("raw-failed", item.id, company.id, input.direction, input.asOfDate,
      JSON.stringify(context), template.templateId, template.templateVersion, JSON.stringify(template), "tool_failed", "2026-09-16T00:00:00.000Z");
    expect(repos.companyResearchRuns.listRuns(item.id, company.id).map((run) => run.id)).toEqual(
      expect.arrayContaining([completed.id, structured.id, "raw-failed"]),
    );
    expect(() => db.prepare("UPDATE company_research_runs SET raw_report_text = 'provider output' WHERE id = 'raw-failed'").run()).toThrow();
    // `tool_failed` is valid globally, so this can only be rejected by the
    // structure_failed state-specific check rather than the failure allowlist.
    expect(() => db.prepare("UPDATE company_research_runs SET last_failure_code = 'tool_failed' WHERE id = ?").run(structured.id)).toThrow();
  });
});
